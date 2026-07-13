/*
Create a refund.
*/

import userIsInGroup from "@cocalc/server/accounts/is-in-group";
import getLogger from "@cocalc/backend/logger";
import getConn from "@cocalc/server/stripe/connection";
import { getTransactionClient } from "@cocalc/database/pool";
import createPurchase from "./create-purchase";
import type { Reason, Refund } from "@cocalc/util/db-schema/purchases";
import { moneyToCurrency, toDecimal } from "@cocalc/util/money";
import send, { support, url } from "@cocalc/server/messages/send";
import { refreshAccountBalanceAndPublishBestEffort } from "./refresh-balance";

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

  return await refundCredit({
    admin_account_id: account_id,
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
}) {
  logger.debug("refundCredit", purchase_id);
  const stripe = await getConn();
  const client = await getTransactionClient();
  let refund_purchase_id;
  let account_id = "";
  let costValue = toDecimal(0);
  let invoice_id: string | undefined;
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
    logger.debug("got locked purchase", purchases);
    if (service != "credit" && service != "auto-credit") {
      throw Error(
        `Only credits can be refunded, but this purchase is of service type '${service}'`,
      );
    }
    if (!invoice_id) {
      throw Error("Only credits with an invoice_id can be refunded");
    }

    const existingRefundPurchaseId =
      getExistingRefundPurchaseId(orig_description);
    if (existingRefundPurchaseId != null) {
      await client.query("COMMIT");
      return existingRefundPurchaseId;
    }

    let paymentIntentId = "";
    if (invoice_id.startsWith("pi_")) {
      paymentIntentId = invoice_id;
      // It's actually a payment intent id, so we have to grab that and get the invoice from there.
      const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
      const intentInvoice =
        stripeId((intent as any).invoice) ??
        stripeMetadataId((intent as any).metadata?.invoice_id) ??
        (await invoiceIdFromInvoicePayments({
          stripe,
          paymentIntentId,
        }));
      if (!intentInvoice) {
        throw Error("payment intent does not reference a refundable invoice");
      }
      invoice_id = intentInvoice;
    }
    if (!invoice_id) {
      throw Error("payment does not reference a refundable invoice");
    }
    const refundableInvoiceId = invoice_id;

    logger.debug("get the invoice_id", refundableInvoiceId);
    const invoice = await stripe.invoices.retrieve(refundableInvoiceId);
    if (!paymentIntentId) {
      paymentIntentId =
        stripeId((invoice as any).payment_intent) ??
        (await paymentIntentIdFromInvoicePayments({
          stripe,
          invoice_id: refundableInvoiceId,
        })) ??
        "";
    }
    const charge = await refundChargeId({ stripe, invoice, paymentIntentId });
    logger.debug("got invoice charge = ", { charge });
    if (!charge) {
      throw Error(
        "corresponding invoice does not have a charge -- i.e., it was not paid in a way that we can refund.",
      );
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
    const refund = await stripe.refunds.create(
      {
        charge,
        metadata: { account_id: admin_account_id, purchase_id } as any,
        reason: reason != "other" ? reason : undefined,
      },
      { idempotencyKey: `cocalc-refund-purchase-${purchase_id}` },
    );

    if (paymentIntentId) {
      await stripe.paymentIntents.update(paymentIntentId, {
        metadata: {
          refund_date: Date.now(),
          refund_reason: reason,
          refund_notes: notes,
        },
      });
    }

    // Record the Stripe refund id so later retries can short-circuit locally.
    await client.query("UPDATE purchases SET description=$2 WHERE id=$1", [
      refund_purchase_id,
      { ...description, refund_id: refund.id },
    ]);
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

  // send confirmation message
  try {
    const subject = `Refund of Transaction ${purchase_id} for ${moneyToCurrency(
      costValue.abs(),
    )} + tax`;
    const body = `
Your credit of ${moneyToCurrency(
      costValue.abs(),
    )} + tax from transaction ${purchase_id} has been refunded.

This refund will appear immediately in [your account](${await url("settings", "purchases")}),
and should post on your credit card or bank statement within 5-10 days.

---

- REASON: ${reason}

- NOTES: ${notes}

${await support()}
`;
    await send({ to_ids: [account_id], subject, body });
  } catch (err) {
    logger.debug("WARNING -- issue sending email", err);
  }

  return refund_purchase_id;
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
