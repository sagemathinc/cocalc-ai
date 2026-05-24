/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getConn from "@cocalc/server/stripe/connection";
import { getStripeCustomerId } from "./util";

const logger = getLogger("purchases:stripe:invoices");

function customerId(customer): string | undefined {
  if (typeof customer === "string") {
    return customer;
  }
  return customer?.id;
}

function assertOwnedByCustomer({
  actual,
  expected,
}: {
  actual;
  expected: string;
}) {
  if (customerId(actual) !== expected) {
    throw Error("invoice not found");
  }
}

export async function getInvoice({
  account_id,
  invoice_id,
}: {
  account_id: string;
  invoice_id: string;
}) {
  logger.debug("getInvoice", { account_id, invoice_id });
  const customer = await getStripeCustomerId({ account_id, create: false });
  if (!customer) {
    throw Error("invoice not found");
  }
  const stripe = await getConn();
  if (invoice_id.startsWith("pi_")) {
    // Legacy fallback for old purchase rows that stored a payment intent id.
    const paymentIntent = await stripe.paymentIntents.retrieve(invoice_id);
    assertOwnedByCustomer({
      actual: paymentIntent.customer,
      expected: customer,
    });
    return paymentIntent;
  }
  const invoice = await stripe.invoices.retrieve(invoice_id);
  assertOwnedByCustomer({
    actual: invoice.customer,
    expected: customer,
  });
  return invoice;
}

export async function getInvoiceUrl({
  account_id,
  invoice_id,
}: {
  account_id: string;
  invoice_id: string;
}): Promise<string | null | undefined> {
  logger.debug("getInvoiceUrl", { account_id, invoice_id });
  const customer = await getStripeCustomerId({ account_id, create: false });
  if (!customer) {
    throw Error("invoice not found");
  }
  const stripe = await getConn();
  if (invoice_id.startsWith("pi_")) {
    // Legacy fallback for old purchase rows that stored a payment intent id.
    const paymentIntent = await stripe.paymentIntents.retrieve(invoice_id);
    assertOwnedByCustomer({
      actual: paymentIntent.customer,
      expected: customer,
    });
    const charges = await stripe.charges.list({
      payment_intent: invoice_id,
    });
    return charges.data?.[0]?.receipt_url;
  }
  const invoice = await stripe.invoices.retrieve(invoice_id);
  assertOwnedByCustomer({
    actual: invoice.customer,
    expected: customer,
  });
  return invoice.hosted_invoice_url;
}
