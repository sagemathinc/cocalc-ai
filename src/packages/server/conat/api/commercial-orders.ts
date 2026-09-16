/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type {
  CommercialBackfillRequest,
  CommercialBackfillResponse,
  CommercialBillingDetailsUpdateRequest,
  CommercialCollectionModeUpdateRequest,
  CommercialDiagnosticsRequest,
  CommercialAssigneeListRequest,
  CommercialFulfillmentPlan,
  CommercialFulfillmentPreviewRequest,
  CommercialInvoiceMutationRequest,
  CommercialInvoiceLinkRequest,
  CommercialInvoicePreview,
  CommercialInvoicePreviewRequest,
  CommercialManualInvoiceIssueRequest,
  CommercialManualPaymentRequest,
  CommercialOrderAssignRequest,
  CommercialOrderCreateRequest,
  CommercialOrderCreatePreview,
  CommercialOrderEventsRequest,
  CommercialOrderEventsResponse,
  CommercialOrderGetRequest,
  CommercialOrderListRequest,
  CommercialOrderListResponse,
  CommercialOrderNoteRequest,
  CommercialOrderDocumentDownload,
  CommercialOrderDocumentDownloadRequest,
  CommercialOrderDocumentUploadRequest,
  CommercialOrderDocumentVoidRequest,
  CommercialOrderRevisionRequest,
  CommercialOrderTransitionRequest,
  CommercialOrderUpdateRequest,
  CommercialProvisionRequest,
  CommercialQuoteDocument,
  CommercialQuoteLinkRequest,
  CommercialQuoteLinkResult,
  CommercialQuoteDocumentRequest,
  CommercialQuoteIssueRequest,
  CommercialQuotePreview,
  CommercialQuotePreviewRequest,
  CommercialQuoteVoidRequest,
  CommercialReconcilePreview,
  CommercialReconcilePreviewRequest,
  CommercialStripeEventRetryRequest,
  CommercialStripeEventRetryResult,
  CommercialStripeQuoteAcceptRequest,
  CommercialStripeQuoteCreateRequest,
  CommercialStripeQuoteMutationRequest,
  CommercialStripeQuotePreview,
  CommercialStripeQuotePreviewRequest,
  SiteLicenseRevenueAnalytics,
  SiteLicenseRevenueAnalyticsRequest,
} from "@cocalc/conat/hub/api/commercial-orders";
import type {
  CommercialOrder,
  CommercialOrderDiagnostics,
} from "@cocalc/util/commercial-orders";
import type { UserSearchResult } from "@cocalc/util/db-schema/accounts";
import centralLog from "@cocalc/database/postgres/central-log";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import { dispatchCommercialSeedRequest } from "@cocalc/server/commercial-orders/dispatch";
import {
  assertCommercialReceivablesCapability,
  type CommercialReceivablesCapability,
} from "@cocalc/server/commercial-orders/feature-flags";
import { recordCommercialOperator } from "@cocalc/server/commercial-orders/observability";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import { requireDangerousSessionAuth } from "./dangerous-session-auth";

type Request = {
  account_id?: string;
  browser_id?: string;
  session_hash?: string;
  reason?: string;
  source?: string;
};

async function requireAdmin(opts: Request, fresh: boolean): Promise<string> {
  const accountId = `${opts.account_id ?? ""}`.trim();
  if (!accountId) throw Error("must be signed in");
  if (!(await isAdmin(accountId))) {
    throw Object.assign(Error("admin privileges required"), { code: 403 });
  }
  const reason = `${opts.reason ?? ""}`.trim();
  if (reason.length < 4)
    throw Error("a human-readable audit reason is required");
  if (reason.length > 2_000)
    throw Error("audit reason must be at most 2000 characters");
  if (fresh) {
    await requireDangerousSessionAuth({
      account_id: accountId,
      browser_id: opts.browser_id,
      session_hash: opts.session_hash,
      require_second_factor: "if_enabled",
      allow_actor_impersonation: false,
    });
  }
  return accountId;
}

async function invoke<T, R extends Request = Request>(
  action: string,
  opts: R,
  {
    fresh = false,
    capability = "visible",
  }: {
    fresh?: boolean;
    capability?: CommercialReceivablesCapability;
  } = {},
): Promise<T> {
  const started = Date.now();
  if (
    opts.source != null &&
    !["admin-ui", "cli", "migration"].includes(opts.source)
  ) {
    throw Error(
      "public commercial-order calls may only use admin-ui, cli, or migration as their source",
    );
  }
  const actorAccountId = await requireAdmin(opts, fresh);
  await assertCommercialReceivablesCapability(capability);
  const payload = { ...opts };
  delete payload.account_id;
  delete payload.browser_id;
  delete payload.session_hash;
  payload.source ??= "admin-ui";
  let error: unknown;
  try {
    if (getConfiguredBayId() === getConfiguredClusterSeedBayId()) {
      return (await dispatchCommercialSeedRequest({
        action,
        actor_account_id: actorAccountId,
        payload,
      })) as T;
    }
    return (await getInterBayBridge()
      .bayOps(getConfiguredClusterSeedBayId(), { timeout_ms: 120_000 })
      .commercialOrders({
        action,
        actor_account_id: actorAccountId,
        payload,
      })) as T;
  } catch (err) {
    error = err;
    recordCommercialOperator(
      action,
      (err as { code?: unknown })?.code === 409 ||
        /current version|optimistic/i.test(`${err}`)
        ? "conflict"
        : "error",
    );
    throw err;
  } finally {
    if (error == null) recordCommercialOperator(action, "success");
    try {
      await centralLog({
        event: "commercial_order_operator",
        value: {
          actor_account_id: actorAccountId,
          action,
          reason: opts.reason,
          order_reference:
            "id" in opts && typeof opts.id === "string"
              ? opts.id.slice(0, 80)
              : null,
          duration_ms: Date.now() - started,
          fresh_auth: fresh,
          ok: error == null,
          error: error == null ? null : `${error}`.slice(0, 500),
        },
      });
    } catch {
      // The immutable commercial event is authoritative; central_log is best-effort.
    }
  }
}

export async function list(
  opts: CommercialOrderListRequest,
): Promise<CommercialOrderListResponse> {
  return await invoke("list", opts);
}

export async function get(
  opts: CommercialOrderGetRequest,
): Promise<CommercialOrder> {
  return await invoke("get", opts);
}

export async function listAssignees(
  opts: CommercialAssigneeListRequest,
): Promise<UserSearchResult[]> {
  return await invoke("listAssignees", opts);
}

export async function events(
  opts: CommercialOrderEventsRequest,
): Promise<CommercialOrderEventsResponse> {
  return await invoke("events", opts);
}

export async function siteLicenseRevenueAnalytics(
  opts: SiteLicenseRevenueAnalyticsRequest,
): Promise<SiteLicenseRevenueAnalytics> {
  return await invoke("siteLicenseRevenueAnalytics", opts);
}

export async function create(
  opts: CommercialOrderCreateRequest,
): Promise<CommercialOrder> {
  return await invoke("create", opts, { fresh: true, capability: "mutate" });
}

export async function createPreview(
  opts: CommercialOrderCreateRequest,
): Promise<CommercialOrderCreatePreview> {
  return await invoke("createPreview", opts);
}

export async function update(
  opts: CommercialOrderUpdateRequest,
): Promise<CommercialOrder> {
  return await invoke("update", opts, { fresh: true, capability: "mutate" });
}

export async function revise(
  opts: CommercialOrderRevisionRequest,
): Promise<CommercialOrder> {
  return await invoke("revise", opts, { fresh: true, capability: "mutate" });
}

export async function assign(
  opts: CommercialOrderAssignRequest,
): Promise<CommercialOrder> {
  return await invoke("assign", opts, { capability: "mutate" });
}

export async function addNote(
  opts: CommercialOrderNoteRequest,
): Promise<CommercialOrder> {
  return await invoke("addNote", opts, { capability: "mutate" });
}

export async function updateBillingDetails(
  opts: CommercialBillingDetailsUpdateRequest,
): Promise<CommercialOrder> {
  return await invoke("updateBillingDetails", opts, {
    fresh: true,
    capability: "mutate",
  });
}

export async function updateCollectionMode(
  opts: CommercialCollectionModeUpdateRequest,
): Promise<CommercialOrder> {
  return await invoke("updateCollectionMode", opts, {
    fresh: true,
    capability: "mutate",
  });
}

export async function approve(
  opts: CommercialOrderTransitionRequest,
): Promise<CommercialOrder> {
  return await invoke("approve", opts, {
    fresh: true,
    capability: "mutate",
  });
}

export async function cancel(
  opts: CommercialOrderTransitionRequest,
): Promise<CommercialOrder> {
  return await invoke("cancel", opts, { fresh: true, capability: "mutate" });
}

export async function quotePreview(
  opts: CommercialQuotePreviewRequest,
): Promise<CommercialQuotePreview> {
  return await invoke("quotePreview", opts);
}

export async function issueQuote(
  opts: CommercialQuoteIssueRequest,
): Promise<CommercialOrder> {
  return await invoke("issueQuote", opts, {
    fresh: true,
    capability: "mutate",
  });
}

export async function voidQuote(
  opts: CommercialQuoteVoidRequest,
): Promise<CommercialOrder> {
  return await invoke("voidQuote", opts, {
    fresh: true,
    capability: "mutate",
  });
}

export async function quoteDocument(
  opts: CommercialQuoteDocumentRequest,
): Promise<CommercialQuoteDocument> {
  return await invoke("quoteDocument", opts);
}

export async function stripeQuotePreview(
  opts: CommercialStripeQuotePreviewRequest,
): Promise<CommercialStripeQuotePreview> {
  return await invoke("stripeQuotePreview", opts);
}

export async function issueQuoteLink(
  opts: CommercialQuoteLinkRequest,
): Promise<CommercialQuoteLinkResult> {
  return await invoke("issueQuoteLink", opts, {
    fresh: true,
    capability: "mutate",
  });
}

export async function revokeQuoteLink(
  opts: CommercialQuoteVoidRequest,
): Promise<CommercialOrder> {
  return await invoke("revokeQuoteLink", opts, {
    fresh: true,
    capability: "mutate",
  });
}

export async function createStripeQuote(
  opts: CommercialStripeQuoteCreateRequest,
): Promise<CommercialOrder> {
  return await invoke("createStripeQuote", opts, {
    fresh: true,
    capability: "stripeQuotes",
  });
}

export async function finalizeStripeQuote(
  opts: CommercialStripeQuoteMutationRequest,
): Promise<CommercialOrder> {
  return await invoke("finalizeStripeQuote", opts, {
    fresh: true,
    capability: "stripeQuoteFinalize",
  });
}

export async function acceptStripeQuote(
  opts: CommercialStripeQuoteAcceptRequest,
): Promise<CommercialOrder> {
  return await invoke("acceptStripeQuote", opts, {
    fresh: true,
    capability: "stripeQuoteAccept",
  });
}

export async function cancelStripeQuote(
  opts: CommercialStripeQuoteMutationRequest,
): Promise<CommercialOrder> {
  return await invoke("cancelStripeQuote", opts, {
    fresh: true,
    capability: "stripeQuotes",
  });
}

export async function reconcileStripeQuote(
  opts: CommercialStripeQuoteMutationRequest,
): Promise<CommercialOrder> {
  return await invoke("reconcileStripeQuote", opts, {
    fresh: true,
    capability: "reconciliation",
  });
}

export async function uploadDocument(
  opts: CommercialOrderDocumentUploadRequest,
): Promise<CommercialOrder> {
  return await invoke("uploadDocument", opts, {
    fresh: true,
    capability: "mutate",
  });
}

export async function voidDocument(
  opts: CommercialOrderDocumentVoidRequest,
): Promise<CommercialOrder> {
  return await invoke("voidDocument", opts, {
    fresh: true,
    capability: "mutate",
  });
}

export async function downloadDocument(
  opts: CommercialOrderDocumentDownloadRequest,
): Promise<CommercialOrderDocumentDownload> {
  return await invoke("downloadDocument", opts);
}

export async function invoicePreview(
  opts: CommercialInvoicePreviewRequest,
): Promise<CommercialInvoicePreview> {
  return await invoke("invoicePreview", opts);
}

export async function createInvoiceDraft(
  opts: CommercialInvoiceMutationRequest,
): Promise<CommercialOrder> {
  return await invoke("createInvoiceDraft", opts, {
    fresh: true,
    capability: "stripeDraft",
  });
}

export async function linkExistingInvoice(
  opts: CommercialInvoiceLinkRequest,
): Promise<CommercialOrder> {
  return await invoke("linkExistingInvoice", opts, {
    fresh: true,
    capability: "stripeDraft",
  });
}

export async function sendInvoice(
  opts: CommercialInvoiceMutationRequest,
): Promise<CommercialOrder> {
  return await invoke("sendInvoice", opts, {
    fresh: true,
    capability: "stripeSend",
  });
}

export async function voidInvoice(
  opts: CommercialInvoiceMutationRequest,
): Promise<CommercialOrder> {
  return await invoke("voidInvoice", opts, {
    fresh: true,
    // Seed dispatch selects the Stripe or manual mutation capability.
    capability: "visible",
  });
}

export async function reconcileInvoice(
  opts: CommercialInvoiceMutationRequest,
): Promise<CommercialOrder> {
  return await invoke("reconcileInvoice", opts, {
    fresh: true,
    capability: "reconciliation",
  });
}

export async function reconcilePreview(
  opts: CommercialReconcilePreviewRequest,
): Promise<CommercialReconcilePreview> {
  return await invoke("reconcilePreview", opts);
}

export async function recordManualPayment(
  opts: CommercialManualPaymentRequest,
): Promise<CommercialOrder> {
  return await invoke("recordManualPayment", opts, {
    fresh: true,
    capability: "manualSettlement",
  });
}

export async function issueManualInvoice(
  opts: CommercialManualInvoiceIssueRequest,
): Promise<CommercialOrder> {
  return await invoke("issueManualInvoice", opts, {
    fresh: true,
    capability: "manualSettlement",
  });
}

export async function fulfillmentPreview(
  opts: CommercialFulfillmentPreviewRequest,
): Promise<CommercialFulfillmentPlan> {
  return await invoke("fulfillmentPreview", opts);
}

export async function provision(
  opts: CommercialProvisionRequest,
): Promise<CommercialOrder> {
  return await invoke("provision", opts, {
    fresh: true,
    capability: "fulfillment",
  });
}

export async function endFulfillment(
  opts: CommercialOrderTransitionRequest,
): Promise<CommercialOrder> {
  return await invoke("endFulfillment", opts, {
    fresh: true,
    capability: "fulfillment",
  });
}

export async function diagnostics(
  opts: CommercialDiagnosticsRequest,
): Promise<CommercialOrderDiagnostics> {
  return await invoke("diagnostics", opts);
}

export async function retryStripeEvent(
  opts: CommercialStripeEventRetryRequest,
): Promise<CommercialStripeEventRetryResult> {
  return await invoke("retryStripeEvent", opts, {
    fresh: true,
    capability: "reconciliation",
  });
}

export async function backfill(
  opts: CommercialBackfillRequest,
): Promise<CommercialBackfillResponse> {
  return await invoke("backfill", opts, {
    fresh: true,
    capability: "mutate",
  });
}
