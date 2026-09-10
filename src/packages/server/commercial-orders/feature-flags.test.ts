/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  COMMERCIAL_ACTION_CAPABILITIES,
  COMMERCIAL_RECEIVABLES_FLAGS,
} from "./feature-flags";

describe("commercial receivables action capabilities", () => {
  it("keeps Stripe quote rollout controls independent", () => {
    expect(COMMERCIAL_RECEIVABLES_FLAGS.stripeQuotes).toBe(
      "commercial_receivables_stripe_quotes_enabled",
    );
    expect(COMMERCIAL_RECEIVABLES_FLAGS.stripeQuoteFinalize).toBe(
      "commercial_receivables_stripe_quote_finalize_enabled",
    );
    expect(COMMERCIAL_RECEIVABLES_FLAGS.stripeQuoteAccept).toBe(
      "commercial_receivables_stripe_quote_accept_enabled",
    );
  });

  it("classifies every public seed action except the internal Stripe webhook", () => {
    expect(Object.keys(COMMERCIAL_ACTION_CAPABILITIES).sort()).toEqual(
      [
        "addNote",
        "approve",
        "assign",
        "backfill",
        "cancel",
        "cancelStripeQuote",
        "create",
        "createPreview",
        "createInvoiceDraft",
        "createStripeQuote",
        "diagnostics",
        "downloadDocument",
        "endFulfillment",
        "events",
        "finalizeStripeQuote",
        "fulfillmentPreview",
        "get",
        "invoicePreview",
        "issueQuote",
        "issueQuoteLink",
        "revokeQuoteLink",
        "issueManualInvoice",
        "linkExistingInvoice",
        "list",
        "listAssignees",
        "provision",
        "quoteDocument",
        "quotePreview",
        "reconcileInvoice",
        "reconcilePreview",
        "reconcileStripeQuote",
        "recordManualPayment",
        "revise",
        "retryStripeEvent",
        "sendInvoice",
        "stripeQuotePreview",
        "update",
        "updateBillingDetails",
        "updateCollectionMode",
        "uploadDocument",
        "voidDocument",
        "voidInvoice",
        "voidQuote",
        "acceptStripeQuote",
      ].sort(),
    );
  });

  it("routes provider-aware voids without assuming Stripe", () => {
    expect(COMMERCIAL_ACTION_CAPABILITIES.voidInvoice).toBe("visible");
    expect(COMMERCIAL_ACTION_CAPABILITIES.issueManualInvoice).toBe(
      "manualSettlement",
    );
    expect(COMMERCIAL_ACTION_CAPABILITIES.revise).toBe("mutate");
  });

  it("gates each Stripe quote mutation with least privilege", () => {
    expect(COMMERCIAL_ACTION_CAPABILITIES.createStripeQuote).toBe(
      "stripeQuotes",
    );
    expect(COMMERCIAL_ACTION_CAPABILITIES.finalizeStripeQuote).toBe(
      "stripeQuoteFinalize",
    );
    expect(COMMERCIAL_ACTION_CAPABILITIES.cancelStripeQuote).toBe(
      "stripeQuotes",
    );
    expect(COMMERCIAL_ACTION_CAPABILITIES.acceptStripeQuote).toBe(
      "stripeQuoteAccept",
    );
    expect(COMMERCIAL_ACTION_CAPABILITIES.reconcileStripeQuote).toBe(
      "reconciliation",
    );
    expect(COMMERCIAL_ACTION_CAPABILITIES.stripeQuotePreview).toBe("visible");
  });
});
