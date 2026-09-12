/*
Create a refund.
*/

import userIsInGroup from "@cocalc/server/accounts/is-in-group";
import getLogger from "@cocalc/backend/logger";
import getConn from "@cocalc/server/stripe/connection";
import getPool, {
  getTransactionClient,
  type PoolClient,
} from "@cocalc/database/pool";
import createPurchase from "./create-purchase";
import type { Reason, Refund, Service } from "@cocalc/util/db-schema/purchases";
import { moneyToCurrency, toDecimal } from "@cocalc/util/money";
import send, { support } from "@cocalc/server/messages/send";
import { refreshAccountBalanceAndPublishBestEffort } from "./refresh-balance";
import cancelSubscription from "./cancel-subscription";
import {
  getMembershipPackage,
  listMembershipPackageAssignments,
  revokeMembershipPackageSeat,
  updateMembershipPackage,
} from "@cocalc/server/membership/packages";
import { recordMembershipAllocationRefund } from "@cocalc/server/membership/allocation-analytics";

const logger = getLogger("purchase:create-refund");

export default async function createRefund(opts: {
  account_id: string;
  purchase_id: number;
  reason: Reason;
  notes?: string;
}): Promise<number> {
  logger.debug("createRefund", opts);
  const { account_id } = opts;
  if (!(await userIsInGroup(account_id, "admin"))) {
    throw Error("only admins can create refunds");
  }
  const { purchase_id, reason, notes = "" } = opts;
  if (
    reason != "duplicate" &&
    reason != "fraudulent" &&
    reason != "requested_by_customer" &&
    reason != "other"
  ) {
    // don't trust typescript, since used via api...
    throw Error(
      `Reason must be one of "duplicate", "fraudulent", "requested_by_customer" or "other"`,
    );
  }

  const { rows } = await getPool().query<{
    description: any;
    service: Service;
  }>("SELECT description, service FROM purchases WHERE id=$1", [purchase_id]);
  const { description, service } = rows[0] ?? {};
  if (!service) {
    throw Error(`No purchase with id ${purchase_id}`);
  }
  if (service === "credit" || service === "auto-credit") {
    return await refundCredit({
      admin_account_id: account_id,
      purchase_id,
      reason,
      notes,
    });
  }
  if (
    service === "membership" &&
    positiveInteger(description?.subscription_id) != null
  ) {
    return await refundMembership({
      admin_account_id: account_id,
      purchase_id,
      reason,
      notes,
    });
  }
  if (
    service === "membership" &&
    description?.type === "membership-package" &&
    nonemptyString(description?.package_id) != null
  ) {
    return await refundMembershipPackage({
      purchase_id,
      reason,
      notes,
    });
  }
  if (service === "refund") {
    throw Error("Refund transactions cannot themselves be refunded");
  }
  if (service === "membership") {
    throw Error(
      `Membership transaction ${purchase_id} is neither a subscription nor a membership package`,
    );
  }
  return await refundInternalPurchase({
    purchase_id,
    reason,
    notes,
  });
}

async function refundCredit({
  admin_account_id,
  purchase_id,
  reason,
  notes,
}: {
  admin_account_id: string;
  purchase_id: number;
  reason: Reason;
  notes: string;
}): Promise<number> {
  logger.debug("refundCredit", purchase_id);
  const client = await getTransactionClient();
  let refund_purchase_id!: number;
  let account_id = "";
  let costValue = toDecimal(0);
  let invoice_id: string | undefined;
  let externalPayment = false;
  try {
    const { rows: purchases } = await client.query(
      "SELECT id, account_id, invoice_id, service, cost, description FROM purchases WHERE id=$1 FOR UPDATE",
      [purchase_id],
    );
    if (purchases.length == 0) {
      throw Error(`No purchase with id ${purchase_id}`);
    }
    const {
      account_id: purchaseAccountId,
      cost,
      description: orig_description,
      service,
    } = purchases[0];
    account_id = purchaseAccountId;
    costValue = toDecimal(cost);
    invoice_id = purchases[0].invoice_id;
    externalPayment = !!invoice_id;
    logger.debug("got locked purchase", purchases);
    if (service != "credit" && service != "auto-credit") {
      throw Error(
        `Only credits can be refunded, but this purchase is of service type '${service}'`,
      );
    }

    const existingRefundPurchaseId =
      getExistingRefundPurchaseId(orig_description);
    if (existingRefundPurchaseId != null) {
      await client.query("COMMIT");
      return existingRefundPurchaseId;
    }

    const stripe = invoice_id ? await getConn() : undefined;
    let paymentIntentId = "";
    let charge: string | undefined;
    if (invoice_id?.startsWith("pi_")) {
      paymentIntentId = invoice_id;
      const intent = await stripe!.paymentIntents.retrieve(paymentIntentId);
      charge =
        stripeId((intent as any).latest_charge) ??
        (await refundChargeId({
          stripe: stripe!,
          invoice: undefined,
          paymentIntentId,
        }));
      const intentInvoice =
        stripeId((intent as any).invoice) ??
        stripeMetadataId((intent as any).metadata?.invoice_id) ??
        (await invoiceIdFromInvoicePayments({
          stripe: stripe!,
          paymentIntentId,
        }));
      if (intentInvoice) {
        invoice_id = intentInvoice;
      } else if (!charge) {
        throw Error("payment intent does not reference a refundable charge");
      } else {
        invoice_id = undefined;
      }
    }
    if (invoice_id) {
      const refundableInvoiceId = invoice_id;
      logger.debug("get the invoice_id", refundableInvoiceId);
      const invoice = await stripe!.invoices.retrieve(refundableInvoiceId);
      if (!paymentIntentId) {
        paymentIntentId =
          stripeId((invoice as any).payment_intent) ??
          (await paymentIntentIdFromInvoicePayments({
            stripe: stripe!,
            invoice_id: refundableInvoiceId,
          })) ??
          "";
      }
      charge =
        charge ??
        (await refundChargeId({
          stripe: stripe!,
          invoice,
          paymentIntentId,
        }));
      logger.debug("got invoice charge = ", { charge });
      if (!charge) {
        throw Error("corresponding invoice does not have a refundable charge");
      }
    }

    const description = {
      type: "refund",
      purchase_id,
      notes,
      reason,
    } as Refund;
    refund_purchase_id = await createPurchase({
      account_id,
      service: "refund",
      cost: costValue.neg(),
      description,
      client,
    });
    const refund = charge
      ? await createOrReuseStripeRefund({
          stripe: stripe!,
          charge,
          admin_account_id,
          purchase_id,
          reason,
        })
      : undefined;

    if (paymentIntentId && stripe) {
      await stripe.paymentIntents.update(paymentIntentId, {
        metadata: {
          refund_date: Date.now(),
          refund_reason: reason,
          refund_notes: notes,
        },
      });
    }

    // Record the Stripe refund id so later retries can short-circuit locally.
    if (refund?.id) {
      await client.query("UPDATE purchases SET description=$2 WHERE id=$1", [
        refund_purchase_id,
        { ...description, refund_id: refund.id },
      ]);
    }
    // we also set new purchase id
    await client.query("UPDATE purchases SET description=$2 WHERE id=$1", [
      purchase_id,
      {
        ...(isObject(orig_description) ? orig_description : {}),
        refund_purchase_id,
      },
    ]);

    await client.query("COMMIT");
    await refreshAccountBalanceAndPublishBestEffort({ account_id });
  } catch (err) {
    logger.debug("error creating refund", { account_id, invoice_id }, err);
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  await sendRefundMessage({
    account_id,
    purchase_id,
    amount: costValue.toString(),
    reason,
    notes,
    details: externalPayment
      ? "The associated Stripe payment was refunded."
      : "The credit was reversed in the CoCalc account.",
  });

  return refund_purchase_id;
}

async function refundMembership({
  admin_account_id,
  purchase_id,
  reason,
  notes,
}: {
  admin_account_id: string;
  purchase_id: number;
  reason: Reason;
  notes: string;
}): Promise<number> {
  const client = await getTransactionClient();
  let purchase!: PurchaseRow;
  let refundPurchaseId!: number;
  let subscriptionId!: number;
  try {
    purchase = await getPurchase(purchase_id, client, true);
    const existing = getExistingRefundPurchaseId(purchase.description);
    if (existing != null) {
      await client.query("COMMIT");
      return existing;
    }
    if (purchase.service !== "membership") {
      throw Error(`Transaction ${purchase_id} is not a membership purchase`);
    }
    if (purchase.cost == null) {
      throw Error(`Membership transaction ${purchase_id} is not finalized`);
    }
    const parsedSubscriptionId = positiveInteger(
      purchase.description?.subscription_id,
    );
    if (parsedSubscriptionId == null) {
      throw Error(
        `Membership transaction ${purchase_id} has no subscription id`,
      );
    }
    subscriptionId = parsedSubscriptionId;

    const { rows: subscriptions } = await client.query(
      `SELECT id
         FROM subscriptions
        WHERE id=$1 AND account_id=$2
        FOR UPDATE`,
      [subscriptionId, purchase.account_id],
    );
    if (!subscriptions[0]) {
      throw Error(`Membership subscription ${subscriptionId} does not exist`);
    }

    const description: Refund = {
      type: "refund",
      purchase_id,
      notes,
      reason,
    };
    refundPurchaseId = await createPurchase({
      account_id: purchase.account_id,
      service: "refund",
      cost: toDecimal(purchase.cost).neg(),
      description,
      client,
    });
    await markPurchaseRefunded({
      client,
      purchase,
      refundPurchaseId,
    });
    await recordMembershipAllocationRefund({
      original_purchase_id: purchase.id,
      refund_purchase_id: refundPurchaseId,
      client,
    });
    await client.query(
      `UPDATE subscriptions
          SET current_period_end=LEAST(current_period_end, NOW()),
              payment=CASE
                WHEN payment IS NULL THEN NULL
                ELSE jsonb_set(payment, '{status}', '"canceled"')
              END
        WHERE id=$1 AND account_id=$2`,
      [subscriptionId, purchase.account_id],
    );
    await cancelSubscription({
      account_id: purchase.account_id,
      subscription_id: subscriptionId,
      reason: adminRefundReason({ admin_account_id, reason, notes }),
      client,
      notify: false,
    });
    await client.query("COMMIT");
    await refreshAccountBalanceAndPublishBestEffort({
      account_id: purchase.account_id,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  await sendRefundMessage({
    account_id: purchase.account_id,
    purchase_id,
    amount: purchase.cost,
    reason,
    notes,
    details:
      `Membership subscription ${subscriptionId} was canceled and expired ` +
      "immediately. The purchase amount was restored to the account balance. " +
      "Any related credit transaction must be refunded separately.",
  });
  return refundPurchaseId;
}

async function refundMembershipPackage({
  purchase_id,
  reason,
  notes,
}: {
  purchase_id: number;
  reason: Reason;
  notes: string;
}): Promise<number> {
  const client = await getTransactionClient();
  let purchase!: PurchaseRow;
  let refundPurchaseId!: number;
  let packageId = "";
  let expiredPackage = false;
  let refundedSeats = 0;
  try {
    purchase = await getPurchase(purchase_id, client, true);
    const existing = getExistingRefundPurchaseId(purchase.description);
    if (existing != null) {
      await client.query("COMMIT");
      return existing;
    }
    if (
      purchase.service !== "membership" ||
      purchase.description?.type !== "membership-package"
    ) {
      throw Error(
        `Transaction ${purchase_id} is not a membership package purchase`,
      );
    }
    if (purchase.cost == null) {
      throw Error(`Membership transaction ${purchase_id} is not finalized`);
    }
    packageId = nonemptyString(purchase.description?.package_id) ?? "";
    if (!packageId) {
      throw Error(
        `Membership package transaction ${purchase_id} has no package id`,
      );
    }
    const pkg = await getMembershipPackage({
      package_id: packageId,
      client,
    });
    if (!pkg) {
      throw Error(`Membership package ${packageId} does not exist`);
    }
    if (pkg.owner_account_id !== purchase.account_id) {
      throw Error(
        `Membership package ${packageId} is not owned by the purchase account`,
      );
    }

    refundedSeats = positiveInteger(purchase.description?.seat_count) ?? 0;
    if (!refundedSeats) {
      throw Error(
        `Membership package transaction ${purchase_id} has no seat count`,
      );
    }
    const expandedExistingPackage =
      purchase.description?.expanded_existing_package === true;
    if (expandedExistingPackage) {
      const nextSeatCount = pkg.seat_count - refundedSeats;
      if (nextSeatCount <= 0) {
        throw Error(
          `Refunding transaction ${purchase_id} would remove every seat from membership package ${packageId}`,
        );
      }
      const activeAssignments = await listMembershipPackageAssignments({
        package_id: packageId,
        client,
      });
      if (activeAssignments.length > nextSeatCount) {
        throw Error(
          `Revoke at least ${activeAssignments.length - nextSeatCount} assigned seat(s) from membership package ${packageId} before refunding transaction ${purchase_id}`,
        );
      }
      await updateMembershipPackage({
        package_id: packageId,
        seat_count: nextSeatCount,
        client,
      });
    } else {
      if (pkg.purchase_id != null && Number(pkg.purchase_id) !== purchase_id) {
        throw Error(
          `Membership package ${packageId} belongs to purchase ${pkg.purchase_id}, not transaction ${purchase_id}`,
        );
      }
      const { rows: activeExpansions } = await client.query<{ id: number }>(
        `SELECT id
           FROM purchases
          WHERE account_id=$1
            AND service='membership'
            AND id<>$2
            AND description->>'type'='membership-package'
            AND description->>'package_id'=$3
            AND description->>'expanded_existing_package'='true'
            AND NOT (description ? 'refund_purchase_id')
          LIMIT 1`,
        [purchase.account_id, purchase_id, packageId],
      );
      if (activeExpansions[0]) {
        throw Error(
          `Refund membership package expansion transaction ${activeExpansions[0].id} before refunding original transaction ${purchase_id}`,
        );
      }
      const assignments = await listMembershipPackageAssignments({
        package_id: packageId,
        client,
      });
      for (const assignment of assignments) {
        const revoked = await revokeMembershipPackageSeat(
          {
            package_id: packageId,
            account_id: assignment.account_id ?? undefined,
            email_address: assignment.account_id
              ? undefined
              : (assignment.email_address ?? undefined),
          },
          client,
        );
        if (!revoked) {
          throw Error(
            `Unable to revoke membership package assignment ${assignment.id}`,
          );
        }
      }
      await updateMembershipPackage({
        package_id: packageId,
        expires_at: new Date(),
        client,
      });
      expiredPackage = true;
    }

    const description: Refund = {
      type: "refund",
      purchase_id,
      notes,
      reason,
    };
    refundPurchaseId = await createPurchase({
      account_id: purchase.account_id,
      service: "refund",
      cost: toDecimal(purchase.cost).neg(),
      description,
      client,
    });
    await markPurchaseRefunded({ client, purchase, refundPurchaseId });
    await recordMembershipAllocationRefund({
      original_purchase_id: purchase.id,
      refund_purchase_id: refundPurchaseId,
      client,
    });
    await client.query("COMMIT");
    await refreshAccountBalanceAndPublishBestEffort({
      account_id: purchase.account_id,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  await sendRefundMessage({
    account_id: purchase.account_id,
    purchase_id,
    amount: purchase.cost,
    reason,
    notes,
    details: expiredPackage
      ? `Membership package ${packageId} was expired and its active seat assignments were revoked. The purchase amount was restored to the account balance. Any related credit transaction must be refunded separately.`
      : `${refundedSeats} seat(s) were removed from membership package ${packageId}. The purchase amount was restored to the account balance. Any related credit transaction must be refunded separately.`,
  });
  return refundPurchaseId;
}

async function refundInternalPurchase({
  purchase_id,
  reason,
  notes,
}: {
  purchase_id: number;
  reason: Reason;
  notes: string;
}): Promise<number> {
  const client = await getTransactionClient();
  let purchase: PurchaseRow | undefined;
  let refundPurchaseId: number;
  try {
    purchase = await getPurchase(purchase_id, client, true);
    const existing = getExistingRefundPurchaseId(purchase.description);
    if (existing != null) {
      await client.query("COMMIT");
      return existing;
    }
    if (purchase.service === "refund") {
      throw Error("Refund transactions cannot themselves be refunded");
    }
    if (purchase.cost == null) {
      throw Error(`Transaction ${purchase_id} is not finalized`);
    }
    const description: Refund = {
      type: "refund",
      purchase_id,
      notes,
      reason,
    };
    refundPurchaseId = await createPurchase({
      account_id: purchase.account_id,
      service: "refund",
      cost: toDecimal(purchase.cost).neg(),
      description,
      client,
    });
    await markPurchaseRefunded({ client, purchase, refundPurchaseId });
    await client.query("COMMIT");
    await refreshAccountBalanceAndPublishBestEffort({
      account_id: purchase.account_id,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  await sendRefundMessage({
    account_id: purchase.account_id,
    purchase_id,
    amount: purchase.cost,
    reason,
    notes,
    details: "The transaction was reversed in the CoCalc account.",
  });
  return refundPurchaseId;
}

interface PurchaseRow {
  id: number;
  account_id: string;
  cost: number | string | null;
  description: any;
  invoice_id?: string | null;
  service: Service;
}

async function getPurchase(
  purchase_id: number,
  client: Pick<PoolClient, "query"> = getPool(),
  forUpdate = false,
): Promise<PurchaseRow> {
  const { rows } = await client.query<PurchaseRow>(
    `SELECT id, account_id, cost, description, invoice_id, service
       FROM purchases
      WHERE id=$1
      ${forUpdate ? "FOR UPDATE" : ""}`,
    [purchase_id],
  );
  if (!rows[0]) {
    throw Error(`No purchase with id ${purchase_id}`);
  }
  return rows[0];
}

async function markPurchaseRefunded({
  client,
  purchase,
  refundPurchaseId,
}: {
  client: Awaited<ReturnType<typeof getTransactionClient>>;
  purchase: PurchaseRow;
  refundPurchaseId: number;
}): Promise<void> {
  await client.query("UPDATE purchases SET description=$2 WHERE id=$1", [
    purchase.id,
    {
      ...(isObject(purchase.description) ? purchase.description : {}),
      refund_purchase_id: refundPurchaseId,
    },
  ]);
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function nonemptyString(value: unknown): string | undefined {
  const normalized = `${value ?? ""}`.trim();
  return normalized || undefined;
}

function adminRefundReason({
  admin_account_id,
  reason,
  notes,
}: {
  admin_account_id: string;
  reason: Reason;
  notes: string;
}): string {
  return [`Admin refund by ${admin_account_id}: ${reason}.`, notes.trim()]
    .filter(Boolean)
    .join(" ");
}

async function sendRefundMessage({
  account_id,
  purchase_id,
  amount,
  reason,
  notes,
  details,
}: {
  account_id: string;
  purchase_id: number;
  amount: number | string | null;
  reason: Reason;
  notes: string;
  details: string;
}): Promise<void> {
  try {
    await send({
      to_ids: [account_id],
      subject: `Refund of Transaction ${purchase_id} for ${moneyToCurrency(
        toDecimal(amount ?? 0).abs(),
      )}`,
      body: `Transaction ${purchase_id} was refunded by an administrator.

${details}

- REASON: ${reason}

- NOTES: ${notes}

${await support()}`,
    });
  } catch (err) {
    logger.debug("WARNING -- issue sending refund message", err);
  }
}

async function createOrReuseStripeRefund({
  stripe,
  charge,
  admin_account_id,
  purchase_id,
  reason,
}: {
  stripe: any;
  charge: string;
  admin_account_id: string;
  purchase_id: number;
  reason: Reason;
}): Promise<{ id?: string }> {
  let stripeCharge: any;
  if (stripe.charges?.retrieve) {
    stripeCharge = await stripe.charges.retrieve(charge, {
      expand: ["refunds"],
    });
  }
  const amount = Number(stripeCharge?.amount);
  const amountRefunded = Number(stripeCharge?.amount_refunded ?? 0);
  if (
    stripeCharge?.refunded === true ||
    (Number.isFinite(amount) && amount > 0 && amountRefunded >= amount)
  ) {
    const expandedRefund = stripeCharge?.refunds?.data?.find(
      ({ status }) => status !== "failed" && status !== "canceled",
    );
    if (expandedRefund?.id) {
      return expandedRefund;
    }
    if (stripe.refunds?.list) {
      const { data } = await stripe.refunds.list({ charge, limit: 100 });
      const existing = data.find(
        ({ status }) => status !== "failed" && status !== "canceled",
      );
      if (existing?.id) {
        return existing;
      }
    }
    // The charge is fully refunded in Stripe even if an old API response does
    // not expose the individual Refund object.
    return {};
  }

  const remainingAmount =
    Number.isFinite(amount) && amount > amountRefunded && amountRefunded > 0
      ? amount - amountRefunded
      : undefined;
  return await stripe.refunds.create(
    {
      charge,
      ...(remainingAmount != null ? { amount: remainingAmount } : {}),
      metadata: { account_id: admin_account_id, purchase_id } as any,
      reason: reason != "other" ? reason : undefined,
    },
    { idempotencyKey: `cocalc-refund-purchase-${purchase_id}` },
  );
}

function getExistingRefundPurchaseId(description: unknown): number | undefined {
  if (!isObject(description)) {
    return undefined;
  }
  const { refund_purchase_id } = description;
  return Number.isInteger(refund_purchase_id)
    ? (refund_purchase_id as number)
    : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value == "object" && !Array.isArray(value);
}

function stripeId(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (isObject(value) && typeof value.id === "string") {
    return value.id;
  }
}

function stripeMetadataId(value: unknown): string | undefined {
  const id = `${value ?? ""}`.trim();
  return id || undefined;
}

function invoicePaymentRecord(records: any[]): any | undefined {
  return (
    records.find(({ status, is_default }) => status === "paid" && is_default) ??
    records.find(({ is_default }) => is_default) ??
    records.find(({ status }) => status === "paid") ??
    records[0]
  );
}

function paymentIntentIdFromInvoicePayment(record): string | undefined {
  const payment = record?.payment;
  if (payment?.type !== "payment_intent") {
    return;
  }
  return stripeId(payment.payment_intent);
}

async function invoiceIdFromInvoicePayments({
  stripe,
  paymentIntentId,
}: {
  stripe;
  paymentIntentId: string;
}): Promise<string | undefined> {
  if (!stripe.invoicePayments?.list) {
    return;
  }
  const { data } = await stripe.invoicePayments.list({
    payment: {
      type: "payment_intent",
      payment_intent: paymentIntentId,
    },
    limit: 10,
  });
  return stripeId(invoicePaymentRecord(data)?.invoice);
}

async function paymentIntentIdFromInvoicePayments({
  stripe,
  invoice_id,
}: {
  stripe;
  invoice_id: string;
}): Promise<string | undefined> {
  if (!stripe.invoicePayments?.list) {
    return;
  }
  const { data } = await stripe.invoicePayments.list({
    invoice: invoice_id,
    payment: { type: "payment_intent" },
    limit: 10,
    expand: ["data.payment.payment_intent"],
  });
  return paymentIntentIdFromInvoicePayment(invoicePaymentRecord(data));
}

async function refundChargeId({
  stripe,
  invoice,
  paymentIntentId,
}: {
  stripe;
  invoice;
  paymentIntentId?: string;
}): Promise<string | undefined> {
  const invoiceCharge = stripeId(invoice?.charge);
  if (invoiceCharge) {
    return invoiceCharge;
  }
  if (!paymentIntentId || !stripe.charges?.list) {
    return;
  }
  const charges = await stripe.charges.list({
    payment_intent: paymentIntentId,
    limit: 1,
  });
  return stripeId(charges.data?.[0]);
}
