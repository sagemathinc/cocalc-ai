/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  addCommercialOrderNote,
  approveCommercialOrder,
  assignCommercialOrder,
  backfillCommercialOrders,
  cancelCommercialOrder,
  createCommercialOrder,
  previewCommercialOrderCreate,
  commercialQuotePreview,
  getCommercialOrder,
  getCommercialInvoice,
  getCommercialOrderDocument,
  getCommercialOrderDiagnostics,
  getCommercialQuoteDocument,
  issueCommercialQuoteLink,
  revokeCommercialQuoteLink,
  issueCommercialQuote,
  issueManualCommercialInvoice,
  listCommercialOrderEvents,
  listCommercialOrders,
  reviseCommercialOrder,
  retryCommercialStripeEvent,
  updateCommercialOrder,
  updateCommercialBillingDetails,
  updateCommercialCollectionMode,
  uploadCommercialOrderDocument,
  voidCommercialQuote,
  voidCommercialOrderDocument,
  voidManualCommercialInvoice,
} from "./store";
import { assertCommercialReceivablesCapability } from "./feature-flags";
import {
  commercialInvoicePreview,
  commercialReconcilePreview,
  createStripeCommercialInvoiceDraft,
  findUnlinkedCommercialStripeInvoices,
  linkExistingStripeCommercialInvoice,
  reconcileStripeCommercialInvoice,
  recordStripeAwareCommercialManualPayment,
  sendStripeCommercialInvoice,
  voidStripeCommercialInvoice,
} from "./invoices/stripe";
import {
  acceptStripeCommercialQuote,
  cancelStripeCommercialQuote,
  commercialStripeQuotePreview,
  createStripeCommercialQuote,
  finalizeStripeCommercialQuote,
  reconcileStripeCommercialQuote,
} from "./quotes/stripe";
import { enqueueCommercialStripeEvent } from "./reconcile";
import {
  commercialFulfillmentPreview,
  endCommercialSiteLicenseFulfillment,
  provisionCommercialSiteLicense,
} from "./fulfillment/site-license";
import admins from "@cocalc/server/accounts/admins";
import { searchClusterAccounts } from "@cocalc/server/inter-bay/accounts";
import { getSiteLicenseRevenueAnalytics } from "./site-license-revenue-analytics";

async function listCommercialAssignees() {
  const accountIds = await admins();
  const matches = await Promise.all(
    accountIds.map(
      async (accountId) =>
        (
          await searchClusterAccounts({
            query: accountId,
            admin: true,
            limit: 1,
          })
        )[0],
    ),
  );
  return matches.filter(
    (account): account is NonNullable<typeof account> => account != null,
  );
}

export interface CommercialSeedRequest {
  action: string;
  actor_account_id: string;
  payload: Record<string, unknown>;
}

export async function dispatchCommercialSeedRequest(
  request: CommercialSeedRequest,
): Promise<unknown> {
  const opts = {
    ...request.payload,
    account_id: request.actor_account_id,
    session_hash: undefined,
    browser_id: undefined,
  } as any;
  switch (request.action) {
    case "list":
      return await listCommercialOrders(opts);
    case "get":
      return await getCommercialOrder(opts.id);
    case "listAssignees":
      return await listCommercialAssignees();
    case "events":
      return await listCommercialOrderEvents(opts);
    case "siteLicenseRevenueAnalytics":
      return await getSiteLicenseRevenueAnalytics({ request: opts });
    case "create":
      return await createCommercialOrder(opts);
    case "createPreview":
      return previewCommercialOrderCreate(opts);
    case "update":
      return await updateCommercialOrder(opts);
    case "revise":
      return await reviseCommercialOrder(opts);
    case "assign":
      return await assignCommercialOrder(opts);
    case "addNote":
      return await addCommercialOrderNote(opts);
    case "updateBillingDetails":
      return await updateCommercialBillingDetails(opts);
    case "updateCollectionMode":
      return await updateCommercialCollectionMode(opts);
    case "approve":
      return await approveCommercialOrder(opts);
    case "cancel":
      return await cancelCommercialOrder(opts);
    case "quotePreview":
      return await commercialQuotePreview(opts);
    case "issueQuote":
      return await issueCommercialQuote(opts);
    case "voidQuote":
      return await voidCommercialQuote(opts);
    case "quoteDocument":
      return await getCommercialQuoteDocument(opts);
    case "issueQuoteLink":
      return await issueCommercialQuoteLink(opts);
    case "revokeQuoteLink":
      return await revokeCommercialQuoteLink(opts);
    case "stripeQuotePreview":
      return await commercialStripeQuotePreview(opts);
    case "createStripeQuote":
      return await createStripeCommercialQuote(opts);
    case "finalizeStripeQuote":
      return await finalizeStripeCommercialQuote(opts);
    case "acceptStripeQuote":
      return await acceptStripeCommercialQuote(opts);
    case "cancelStripeQuote":
      return await cancelStripeCommercialQuote(opts);
    case "reconcileStripeQuote":
      return await reconcileStripeCommercialQuote(opts);
    case "uploadDocument":
      return await uploadCommercialOrderDocument(opts);
    case "voidDocument":
      return await voidCommercialOrderDocument(opts);
    case "downloadDocument":
      return await getCommercialOrderDocument(opts);
    case "recordManualPayment":
      return await recordStripeAwareCommercialManualPayment(opts);
    case "issueManualInvoice":
      return await issueManualCommercialInvoice(opts);
    case "invoicePreview":
      return await commercialInvoicePreview(opts);
    case "createInvoiceDraft":
      return await createStripeCommercialInvoiceDraft(opts);
    case "linkExistingInvoice":
      return await linkExistingStripeCommercialInvoice(opts);
    case "sendInvoice":
      return await sendStripeCommercialInvoice(opts);
    case "voidInvoice":
      if (
        (await getCommercialInvoice(opts.id, opts.commercial_invoice_id))
          .provider === "manual"
      ) {
        await assertCommercialReceivablesCapability("manualSettlement");
        return await voidManualCommercialInvoice(opts);
      }
      await assertCommercialReceivablesCapability("stripeSend");
      return await voidStripeCommercialInvoice(opts);
    case "reconcileInvoice":
      return await reconcileStripeCommercialInvoice(opts);
    case "reconcilePreview":
      return await commercialReconcilePreview(opts);
    case "stripeWebhook":
      return await enqueueCommercialStripeEvent(opts);
    case "fulfillmentPreview":
      return await commercialFulfillmentPreview(opts);
    case "provision":
      return await provisionCommercialSiteLicense(opts);
    case "endFulfillment":
      return await endCommercialSiteLicenseFulfillment(opts);
    case "diagnostics": {
      const diagnostics = await getCommercialOrderDiagnostics();
      if (opts.reconcile === true) {
        const scan = await findUnlinkedCommercialStripeInvoices();
        diagnostics.review_queues.unlinked_commercial_stripe_invoices =
          scan.invoices;
        diagnostics.review_queues.truncated.unlinked_commercial_stripe_invoices =
          scan.truncated;
      }
      return diagnostics;
    }
    case "retryStripeEvent":
      return await retryCommercialStripeEvent(opts);
    case "backfill":
      return await backfillCommercialOrders(opts);
    default:
      throw Error(`unsupported commercial seed action '${request.action}'`);
  }
}
