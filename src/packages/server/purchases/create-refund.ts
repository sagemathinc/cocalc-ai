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
import { lockAccountSpending } from "./lock-account-spending";
import { lockMembershipSubscriptionAccount } from "./membership-subscription-guard";
import { assertDebitPreservesPrepaidHolds } from "./assert-debit-preserves-prepaid-holds";
import {
  prepareProviderRefund,
  bindProviderRefundRequest,
  recordProviderRefundResult,
} from "./provider-refund-attempts";
import type { ProviderRefundAttempt } from "./provider-refund-attempts";
import { inspectProviderRefundCharge } from "./provider-refund-reader";
import { registerBillingAuthorityAccount } from "@cocalc/server/purchases/billing-authority/context";

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
    account_id: string;
    description: any;
    service: Service;
    invoice_id: string | null;
  }>(
    "SELECT account_id, description, service, invoice_id FROM purchases WHERE id=$1",
    [purchase_id],
  );
  const {
    account_id: targetAccountId,
    description,
    service,
    invoice_id,
  } = rows[0] ?? {};
  if (!service || !targetAccountId) {
    throw Error(`No purchase with id ${purchase_id}`);
  }
  await registerBillingAuthorityAccount(targetAccountId);
  if (service === "credit-transfer") {
    throw Error(
      "Credit transfers require a separately approved compensating transfer",
    );
  }
  // An immutable historical receipt needs no new spending authority.
  const existing = getExistingRefundPurchaseId(description);
  if (existing != null) return existing;
  if (service === "credit" || service === "auto-credit") {
    if (!invoice_id) {
      return await refundInternalPurchase({ purchase_id, reason, notes });
    }
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
  const purchase = await getPurchase(purchase_id);
  const prepared = await prepareProviderRefund({
    account_id: purchase.account_id,
    purchase_id,
    admin_account_id,
    reason,
    notes,
  });
  if (!("id" in prepared)) return prepared.refund_purchase_id;
  if (prepared.state === "succeeded") return prepared.refund_purchase_id!;
  if (prepared.state === "failed")
    throw Error(
      "This refund failed at the payment provider; reconcile it before requesting another refund",
    );
  const stripe = await getConn();
  let invoice_id: string | undefined = prepared.invoice_id;
  let paymentIntentId = "";
  let charge: string | undefined = prepared.provider_request?.charge;
  if (!charge && invoice_id.startsWith("pi_")) {
    paymentIntentId = invoice_id;
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
    charge =
      stripeId((intent as any).latest_charge) ??
      (await refundChargeId({ stripe, invoice: undefined, paymentIntentId }));
    invoice_id =
      stripeId((intent as any).invoice) ??
      stripeMetadataId((intent as any).metadata?.invoice_id) ??
      (await invoiceIdFromInvoicePayments({ stripe, paymentIntentId }));
    if (!invoice_id && !charge)
      throw Error("payment intent does not reference a refundable charge");
  }
  if (!charge && invoice_id) {
    const invoice = await stripe.invoices.retrieve(invoice_id);
    paymentIntentId =
      stripeId((invoice as any).payment_intent) ??
      (await paymentIntentIdFromInvoicePayments({ stripe, invoice_id })) ??
      "";
    charge = await refundChargeId({ stripe, invoice, paymentIntentId });
  }
  if (!charge)
    throw Error("corresponding invoice does not have a refundable charge");

  const refund = prepared.provider_result
    ? await stripe.refunds.retrieve(prepared.provider_result.id)
    : await createOrReuseStripeRefund({
        stripe,
        charge,
        admin_account_id: prepared.request.admin_account_id,
        purchase_id,
        reason: prepared.request.reason,
        attempt: prepared,
      });
  if (stripeId((refund as any).charge) !== charge)
    throw Error(
      "Provider refund belongs to another charge; funds remain reserved",
    );
  const settled = await recordProviderRefundResult(prepared, {
    id: refund.id ?? "",
    charge,
    status: (refund as any).status ?? "",
    amount: (refund as any).amount,
  });
  if (settled.state !== "succeeded") {
    if (
      settled.state === "pending" &&
      ["failed", "canceled"].includes(settled.provider_result?.status ?? "")
    ) {
      throw Error("Partial refund needs reconciliation; funds remain reserved");
    }
    throw Error(
      settled.state === "failed"
        ? "The payment provider rejected this refund; its hold was released. Reconcile before retrying."
        : "The payment provider is still processing this refund; funds remain reserved. Retry to check its status.",
    );
  }
  await refreshAccountBalanceAndPublishBestEffort({
    account_id: purchase.account_id,
  });
  // Ancillary metadata failure must not undo a settled refund or its receipt.
  if (paymentIntentId) {
    try {
      await stripe.paymentIntents.update(paymentIntentId, {
        metadata: {
          refund_date: Date.now(),
          refund_reason: settled.request.reason,
          refund_notes: settled.request.notes,
        },
      });
    } catch (err) {
      logger.debug("Unable to annotate settled provider refund", err);
    }
  }
  await sendRefundMessage({
    account_id: purchase.account_id,
    purchase_id,
    amount: settled.amount,
    reason: settled.request.reason,
    notes: settled.request.notes,
    details: "The associated Stripe payment was refunded.",
  });
  return settled.refund_purchase_id!;
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
    purchase = await getPurchaseForLocalRefund(purchase_id, client, true);
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
              END,
              resume_payment_intent=NULL
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
    purchase = await getPurchaseForLocalRefund(purchase_id, client);
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
    purchase = await getPurchaseForLocalRefund(purchase_id, client);
    const existing = getExistingRefundPurchaseId(purchase.description);
    if (existing != null) {
      await client.query("COMMIT");
      return existing;
    }
    if (purchase.service === "refund") {
      throw Error("Refund transactions cannot themselves be refunded");
    }
    if (
      (purchase.service === "credit" || purchase.service === "auto-credit") &&
      purchase.invoice_id
    ) {
      throw Error(
        "Credit now references a provider payment; retry through the provider refund workflow",
      );
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

async function getPurchaseForLocalRefund(
  purchase_id: number,
  client: PoolClient,
  subscription = false,
): Promise<PurchaseRow> {
  // Discover the payer without a row lock, then take account locks before any
  // purchase/subscription/package rows, just as admission and renewal do.
  const observed = await getPurchase(purchase_id, client);
  if (subscription) {
    await lockMembershipSubscriptionAccount({
      account_id: observed.account_id,
      client,
    });
  } else {
    await lockAccountSpending(client, observed.account_id);
  }
  const purchase = await getPurchase(purchase_id, client, true);
  if (purchase.account_id !== observed.account_id) {
    throw Error("Purchase account changed while preparing refund; retry");
  }
  if (
    getExistingRefundPurchaseId(purchase.description) == null &&
    purchase.cost != null &&
    toDecimal(purchase.cost).lt(0)
  ) {
    await assertDebitPreservesPrepaidHolds({
      account_id: purchase.account_id,
      client,
      amount: toDecimal(purchase.cost).neg(),
    });
  }
  return purchase;
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
  attempt,
}: {
  stripe: any;
  charge: string;
  admin_account_id: string;
  purchase_id: number;
  reason: Reason;
  attempt: ProviderRefundAttempt;
}): Promise<{ id?: string }> {
  const {
    amount,
    amount_refunded: amountRefunded,
    refund,
  } = await inspectProviderRefundCharge(stripe, attempt, charge);
  if (refund) return refund;
  const bound = await bindProviderRefundRequest(
    attempt,
    {
      charge,
      amount: amount - amountRefunded,
      metadata: { account_id: admin_account_id, purchase_id },
      reason: reason !== "other" ? reason : undefined,
    },
    amountRefunded,
  );
  if (bound.provider_result) return bound.provider_result;
  // Stripe may prune idempotency keys after 24 hours. Do not issue a fresh
  // mutation for an old uncertain request; read/reconcile its result instead.
  if (
    !bound.dispatched_at ||
    Date.now() - new Date(bound.dispatched_at).getTime() >= 23 * 60 * 60 * 1000
  ) {
    throw Error(
      "Refund retry window expired; funds remain reserved pending provider reconciliation",
    );
  }
  return await stripe.refunds.create(bound.provider_request!, {
    idempotencyKey: `cocalc-refund-${bound.id}`,
  });
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
