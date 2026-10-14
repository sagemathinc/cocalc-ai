/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Card, US bank debit (ACH), and bank transfer: "customer_balance" puts the
// customer's Stripe virtual bank account on the invoice, which also accepts
// international (SWIFT) wires in USD. Commercial orders are USD only, so the
// transfer type is always us_bank_transfer.
const PAYMENT_METHOD_TYPES = [
  "card",
  "us_bank_account",
  "customer_balance",
] as const;
const FUNDING_TYPE = "bank_transfer";
const BANK_TRANSFER_TYPE = "us_bank_transfer";

// Invoices created before bank transfer was offered have card + ACH only.
// Every invoice we create or normalize now records the settings version in
// its Stripe metadata, so only an invoice without that marker may use the
// legacy set: a current invoice that lost bank transfer is drift.
const LEGACY_PAYMENT_METHOD_TYPES = ["card", "us_bank_account"] as const;
export const PAYMENT_SETTINGS_METADATA_KEY = "commercial_payment_settings";
export const PAYMENT_SETTINGS_VERSION = "bank-transfer-v1";

export function commercialInvoicePaymentSettings() {
  return {
    payment_method_types: [...PAYMENT_METHOD_TYPES],
    payment_method_options: {
      customer_balance: {
        funding_type: FUNDING_TYPE as typeof FUNDING_TYPE,
        bank_transfer: {
          type: BANK_TRANSFER_TYPE as typeof BANK_TRANSFER_TYPE,
        },
      },
    },
  };
}

export function commercialInvoicePaymentMetadata(): Record<string, string> {
  return { [PAYMENT_SETTINGS_METADATA_KEY]: PAYMENT_SETTINGS_VERSION };
}

function sameMethods(actual: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(actual)) return false;
  return (
    JSON.stringify(actual.map(String).sort()) ===
    JSON.stringify([...expected].sort())
  );
}

/** True if a Stripe invoice has exactly the current payment settings. */
export function hasCurrentPaymentSettings(stripeInvoice: any): boolean {
  const settings = stripeInvoice?.payment_settings;
  if (!sameMethods(settings?.payment_method_types, PAYMENT_METHOD_TYPES)) {
    return false;
  }
  const balance = settings?.payment_method_options?.customer_balance;
  return (
    balance?.funding_type === FUNDING_TYPE &&
    balance?.bank_transfer?.type === BANK_TRANSFER_TYPE
  );
}

/** True if a Stripe invoice still has the payment settings we created it with. */
export function hasApprovedPaymentSettings(stripeInvoice: any): boolean {
  if (hasCurrentPaymentSettings(stripeInvoice)) return true;
  return (
    sameMethods(
      stripeInvoice?.payment_settings?.payment_method_types,
      LEGACY_PAYMENT_METHOD_TYPES,
    ) && stripeInvoice?.metadata?.[PAYMENT_SETTINGS_METADATA_KEY] == null
  );
}

/** Stripe rejected a reused idempotency key sent with different parameters. */
export function isStripeIdempotencyError(err: any): boolean {
  return (
    err?.type === "StripeIdempotencyError" ||
    err?.rawType === "idempotency_error"
  );
}
