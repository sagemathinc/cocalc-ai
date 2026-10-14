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
// Invoices created before bank transfer was offered remain valid.
const LEGACY_PAYMENT_METHOD_TYPES = ["card", "us_bank_account"] as const;

export function commercialInvoicePaymentSettings() {
  return {
    payment_method_types: [...PAYMENT_METHOD_TYPES],
    payment_method_options: {
      customer_balance: {
        funding_type: "bank_transfer" as const,
        bank_transfer: { type: "us_bank_transfer" as const },
      },
    },
  };
}

export function isApprovedPaymentMethodSet(value: unknown): boolean {
  const actual = JSON.stringify(
    Array.isArray(value) ? value.map(String).sort() : [],
  );
  return [
    PAYMENT_METHOD_TYPES as readonly string[],
    LEGACY_PAYMENT_METHOD_TYPES as readonly string[],
  ].some((allowed) => JSON.stringify([...allowed].sort()) === actual);
}
