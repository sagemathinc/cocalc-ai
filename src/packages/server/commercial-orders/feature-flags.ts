/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { getServerSettings } from "@cocalc/database/settings/server-settings";

export const COMMERCIAL_RECEIVABLES_FLAGS = {
  visible: "commercial_receivables_visible",
  mutate: "commercial_receivables_mutations_enabled",
  stripeDraft: "commercial_receivables_stripe_drafts_enabled",
  stripeSend: "commercial_receivables_stripe_send_enabled",
  stripeQuotes: "commercial_receivables_stripe_quotes_enabled",
  stripeQuoteFinalize: "commercial_receivables_stripe_quote_finalize_enabled",
  stripeQuoteAccept: "commercial_receivables_stripe_quote_accept_enabled",
  manualSettlement: "commercial_receivables_manual_settlement_enabled",
  reconciliation: "commercial_receivables_reconciliation_enabled",
  fulfillment: "commercial_receivables_fulfillment_enabled",
} as const;

export type CommercialReceivablesCapability =
  keyof typeof COMMERCIAL_RECEIVABLES_FLAGS;

// Keep attached-bay authorization exhaustive and reviewable in one place.
export const COMMERCIAL_ACTION_CAPABILITIES = {
  list: "visible",
  listAssignees: "visible",
  get: "visible",
  events: "visible",
  stripeQuotePreview: "visible",
  quotePreview: "visible",
  quoteDocument: "visible",
  downloadDocument: "visible",
  invoicePreview: "visible",
  reconcilePreview: "visible",
  fulfillmentPreview: "visible",
  diagnostics: "visible",
  createPreview: "visible",
  create: "mutate",
  update: "mutate",
  revise: "mutate",
  assign: "mutate",
  addNote: "mutate",
  approve: "mutate",
  cancel: "mutate",
  backfill: "mutate",
  updateBillingDetails: "mutate",
  updateCollectionMode: "mutate",
  issueQuote: "mutate",
  voidQuote: "mutate",
  issueQuoteLink: "mutate",
  revokeQuoteLink: "mutate",
  uploadDocument: "mutate",
  voidDocument: "mutate",
  createStripeQuote: "stripeQuotes",
  finalizeStripeQuote: "stripeQuoteFinalize",
  acceptStripeQuote: "stripeQuoteAccept",
  cancelStripeQuote: "stripeQuotes",
  reconcileStripeQuote: "reconciliation",
  createInvoiceDraft: "stripeDraft",
  linkExistingInvoice: "stripeDraft",
  sendInvoice: "stripeSend",
  // Provider-aware dispatch applies the stronger Stripe/manual capability.
  voidInvoice: "visible",
  reconcileInvoice: "reconciliation",
  retryStripeEvent: "reconciliation",
  recordManualPayment: "manualSettlement",
  issueManualInvoice: "manualSettlement",
  provision: "fulfillment",
  endFulfillment: "fulfillment",
} as const satisfies Record<string, CommercialReceivablesCapability>;

export async function isCommercialReceivablesCapabilityEnabled(
  capability: CommercialReceivablesCapability,
): Promise<boolean> {
  const settings = await getServerSettings();
  return settings[COMMERCIAL_RECEIVABLES_FLAGS[capability]] === true;
}

export async function assertCommercialReceivablesCapability(
  capability: CommercialReceivablesCapability,
): Promise<void> {
  if (await isCommercialReceivablesCapabilityEnabled(capability)) return;
  throw Object.assign(
    Error(
      `commercial receivables capability '${capability}' is disabled by site settings`,
    ),
    { code: 503 },
  );
}

export async function getCommercialReceivablesCapabilities(): Promise<
  Record<CommercialReceivablesCapability, boolean>
> {
  const settings = await getServerSettings();
  return Object.fromEntries(
    Object.entries(COMMERCIAL_RECEIVABLES_FLAGS).map(([name, setting]) => [
      name,
      settings[setting] === true,
    ]),
  ) as Record<CommercialReceivablesCapability, boolean>;
}
