/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type {
  CommercialCollectionMode,
  CommercialCollectionState,
  CommercialEventSource,
  CommercialFulfillmentState,
  CommercialNextAction,
  CommercialOrder,
  CommercialOrderContact,
  CommercialOrderDocument,
  CommercialOrderDocumentKind,
  CommercialOrderDiagnostics,
  CommercialOrderEvent,
  CommercialOrderItem,
  CommercialOrderSummary,
  CommercialPaymentMethod,
  CommercialQuote,
  CommercialSiteLicensePlan,
  CommercialWorkflowState,
} from "@cocalc/util/commercial-orders";
import type { UserSearchResult } from "@cocalc/util/db-schema/accounts";
import { authFirstRequireAccount } from "./util";

interface CommercialAuthenticatedRequest {
  account_id?: string;
  browser_id?: string;
  session_hash?: string;
}

export interface CommercialReadRequest extends CommercialAuthenticatedRequest {
  reason: string;
}

export interface CommercialMutationRequest extends CommercialReadRequest {
  source?: CommercialEventSource;
  idempotency_key?: string;
  expected_version?: number;
}

export interface CommercialOrderListRequest extends CommercialReadRequest {
  workflow_states?: CommercialWorkflowState[];
  collection_states?: CommercialCollectionState[];
  fulfillment_states?: CommercialFulfillmentState[];
  assignee_account_id?: string | null;
  organization?: string;
  zendesk_ticket_id?: number;
  site_license_id?: string;
  needs_action?: boolean;
  stale_before?: string;
  next_action_due_before?: string;
  min_amount?: string;
  max_amount?: string;
  search?: string;
  cursor?: string;
  limit?: number;
  max_bytes?: number;
}

export interface CommercialOrderListResponse {
  orders: CommercialOrderSummary[];
  next_cursor?: string;
  truncated: boolean;
  result_bytes: number;
}

export interface CommercialOrderGetRequest extends CommercialReadRequest {
  id: string;
}

export type CommercialAssigneeListRequest = CommercialReadRequest;

export interface CommercialOrderEventsRequest extends CommercialReadRequest {
  id: string;
  cursor?: string;
  limit?: number;
  max_bytes?: number;
}

export interface CommercialOrderEventsResponse {
  events: CommercialOrderEvent[];
  next_cursor?: string;
  truncated: boolean;
  result_bytes: number;
}

export type CommercialOrderItemInput = Pick<
  CommercialOrderItem,
  "description" | "quantity" | "unit_amount" | "subtotal" | "product_kind"
> &
  Partial<
    Pick<
      CommercialOrderItem,
      | "id"
      | "position"
      | "service_start"
      | "service_end"
      | "product_reference"
      | "metadata"
    >
  >;

export type CommercialOrderContactInput = Pick<
  CommercialOrderContact,
  "role" | "name_snapshot" | "email_snapshot"
> &
  Partial<
    Pick<
      CommercialOrderContact,
      "id" | "crm_person_id" | "organization_snapshot"
    >
  >;

export interface CommercialOrderCreateRequest extends CommercialMutationRequest {
  organization_name: string;
  crm_organization_id?: string;
  customer_account_id?: string;
  site_license_id?: string;
  stripe_customer_id?: string;
  zendesk_ticket_ids?: number[];
  workflow_state?: CommercialWorkflowState;
  collection_mode?: CommercialCollectionMode;
  currency?: string;
  agreed_subtotal: string;
  agreed_total?: string;
  service_starts_at?: string;
  service_ends_at?: string;
  payment_terms_days?: number;
  po_number?: string;
  customer_reference?: string;
  terms_snapshot?: Record<string, unknown>;
  assignee_account_id?: string;
  next_action: CommercialNextAction;
  next_action_due_at?: string;
  items: CommercialOrderItemInput[];
  contacts: CommercialOrderContactInput[];
}

export type CommercialOrderNormalizedCreateRequest = Omit<
  CommercialOrderCreateRequest,
  "items"
> & {
  items: Array<CommercialOrderItemInput & { position: number }>;
};

export interface CommercialOrderCreatePreview {
  normalized_request: CommercialOrderNormalizedCreateRequest;
  approval_ready: boolean;
  approval_blockers: string[];
}

export interface CommercialOrderUpdateRequest extends CommercialMutationRequest {
  id: string;
  changes: Partial<
    Pick<
      CommercialOrder,
      | "crm_organization_id"
      | "organization_name"
      | "customer_account_id"
      | "site_license_id"
      | "stripe_customer_id"
      | "zendesk_ticket_ids"
      | "workflow_state"
      | "collection_mode"
      | "currency"
      | "agreed_subtotal"
      | "agreed_total"
      | "service_starts_at"
      | "service_ends_at"
      | "payment_terms_days"
      | "po_number"
      | "customer_reference"
      | "terms_snapshot"
      | "assignee_account_id"
      | "next_action"
      | "next_action_due_at"
    >
  >;
  items?: CommercialOrderItemInput[];
  contacts?: CommercialOrderContactInput[];
}

export type CommercialOrderRevisionRequest = CommercialOrderUpdateRequest;

export interface CommercialOrderAssignRequest extends CommercialMutationRequest {
  id: string;
  assignee_account_id?: string | null;
  next_action?: CommercialNextAction;
  next_action_due_at?: string | null;
}

export interface CommercialOrderNoteRequest extends CommercialMutationRequest {
  id: string;
  note: string;
}

export interface CommercialBillingAddress {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  country?: string;
}

export interface CommercialBillingDetailsUpdateRequest extends CommercialMutationRequest {
  id: string;
  billing_contacts: CommercialOrderContactInput[];
  procurement_contacts?: CommercialOrderContactInput[];
  billing_address?: CommercialBillingAddress | null;
  invoice_memo?: string | null;
}

export interface CommercialCollectionModeUpdateRequest extends CommercialMutationRequest {
  id: string;
  collection_mode: Exclude<CommercialCollectionMode, "complimentary">;
}

export interface CommercialOrderTransitionRequest extends CommercialMutationRequest {
  id: string;
}

export interface CommercialInvoicePreview {
  automatic_tax?: boolean;
  tax_code?: string;
  order_id: string;
  order_number: string;
  organization_name: string;
  stripe_customer_id?: string | null;
  billing_contacts: CommercialOrderContact[];
  items: CommercialOrderItem[];
  currency: string;
  subtotal: string;
  total: string;
  due_at: string;
  payment_terms_days: number;
  po_number?: string | null;
  customer_reference?: string | null;
  invoice_memo?: string | null;
  billing_address?: Record<string, string> | null;
  metadata: Record<string, string>;
  ready: boolean;
  blockers: string[];
}

export interface CommercialInvoicePreviewRequest extends CommercialReadRequest {
  id: string;
}

export interface CommercialQuotePreview {
  order_id: string;
  order_number: string;
  organization_name: string;
  billing_contacts: CommercialOrderContact[];
  items: CommercialOrderItem[];
  currency: string;
  subtotal: string;
  total: string;
  service_starts_at?: string | null;
  service_ends_at?: string | null;
  po_number?: string | null;
  customer_reference?: string | null;
  quote_memo?: string | null;
  billing_address?: CommercialBillingAddress | null;
  default_valid_until: string;
  ready: boolean;
  blockers: string[];
}

export interface CommercialQuotePreviewRequest extends CommercialReadRequest {
  id: string;
}

export interface CommercialQuoteIssueRequest extends CommercialMutationRequest {
  id: string;
  valid_until?: string;
}

export interface CommercialQuoteVoidRequest extends CommercialMutationRequest {
  id: string;
  commercial_quote_id: string;
}

export interface CommercialQuoteDocumentRequest extends CommercialReadRequest {
  id: string;
  commercial_quote_id: string;
}

export interface CommercialQuoteDocument {
  quote: CommercialQuote;
  content_base64: string;
}

export interface CommercialQuoteLinkRequest extends CommercialQuoteVoidRequest {
  expires_at: string;
}

export interface CommercialQuoteLinkResult {
  order: CommercialOrder;
  // Returned only once. An idempotent replay cannot recover the bearer token.
  path: string | null;
}

export interface CommercialStripeQuotePreview extends CommercialQuotePreview {
  automatic_tax?: boolean;
  tax_code?: string;
  stripe_mode: "test" | "live";
  stripe_customer_id?: string | null;
  collection_method: "send_invoice";
  payment_terms_days: number;
  description: string;
  header: string;
  footer: string;
  metadata: Record<string, string>;
  products: Array<{
    commercial_order_item_id: string;
    product_kind: string;
    provider_product_id?: string | null;
    quantity: number;
    unit_amount: number;
  }>;
}

export interface CommercialStripeQuotePreviewRequest extends CommercialReadRequest {
  id: string;
  valid_until?: string;
}

export interface CommercialStripeQuoteCreateRequest extends CommercialMutationRequest {
  id: string;
  valid_until?: string;
}

export interface CommercialStripeQuoteMutationRequest extends CommercialMutationRequest {
  id: string;
  commercial_quote_id: string;
}

export interface CommercialStripeQuoteAcceptRequest extends CommercialStripeQuoteMutationRequest {
  customer_acceptance_confirmed: boolean;
}

export interface CommercialOrderDocumentUploadRequest extends CommercialMutationRequest {
  id: string;
  document_kind: CommercialOrderDocumentKind;
  document_filename: string;
  content_base64: string;
  document_reference?: string;
  note?: string;
}

export interface CommercialOrderDocumentVoidRequest extends CommercialMutationRequest {
  id: string;
  commercial_order_document_id: string;
}

export interface CommercialOrderDocumentDownloadRequest extends CommercialReadRequest {
  id: string;
  commercial_order_document_id: string;
}

export interface CommercialOrderDocumentDownload {
  document: CommercialOrderDocument;
  content_base64: string;
}

export interface CommercialInvoiceMutationRequest extends CommercialMutationRequest {
  id: string;
  commercial_invoice_id?: string;
}

export interface CommercialReconcilePreviewRequest extends CommercialReadRequest {
  id: string;
  commercial_invoice_id?: string;
}

export interface CommercialReconcilePreview {
  order_id: string;
  commercial_invoice_id: string;
  provider_invoice_id?: string | null;
  local_status: string;
  local_total: string;
  local_amount_due: string;
  last_reconciled_at?: string | null;
  stale: boolean;
  ready: boolean;
  blockers: string[];
}

export interface CommercialInvoiceLinkRequest extends CommercialMutationRequest {
  id: string;
  provider_invoice_id: string;
}

export interface CommercialManualPaymentRequest extends CommercialMutationRequest {
  id: string;
  commercial_invoice_id?: string;
  amount: string;
  currency: string;
  received_at?: string;
  method: CommercialPaymentMethod;
  evidence_reference: string;
  provider_payment_id?: string;
}

export interface CommercialManualInvoiceIssueRequest extends CommercialMutationRequest {
  id: string;
  invoice_reference: string;
  due_at?: string;
  issued_at?: string;
  document_url?: string;
  evidence_reference?: string;
}

export interface CommercialFulfillmentPreviewRequest extends CommercialReadRequest {
  id: string;
}

export interface CommercialFulfillmentPlan {
  order_id: string;
  adapter: "site_license";
  action: "create" | "link" | "update" | "none";
  site_license_id?: string | null;
  plan?: CommercialSiteLicensePlan;
  planned_changes: string[];
  ready: boolean;
  blockers: string[];
}

export interface CommercialProvisionRequest extends CommercialMutationRequest {
  id: string;
  allow_before_payment?: boolean;
  existing_site_license_id?: string;
}

export interface CommercialDiagnosticsRequest extends CommercialReadRequest {
  reconcile?: boolean;
}

export interface CommercialStripeEventRetryRequest extends CommercialMutationRequest {
  event_id: string;
}

export interface CommercialStripeEventRetryResult {
  event_id: string;
  status: "pending";
  commercial_order_id: string;
}

export interface CommercialBackfillCandidate {
  organization_name: string;
  site_license_id?: string;
  customer_account_id?: string;
  zendesk_ticket_ids?: number[];
  agreed_total: string;
  currency?: string;
  next_action: CommercialNextAction;
  next_action_due_at?: string;
  service_starts_at?: string;
  service_ends_at?: string;
  billing_contact?: CommercialOrderContactInput;
  provenance?: {
    source: string;
    reference: string;
  };
  invoice?: {
    reference: string;
    issued_at: string;
    due_at?: string;
    document_url?: string;
    evidence_reference?: string;
  };
  payment?: {
    amount: string;
    received_at: string;
    method: CommercialPaymentMethod;
    evidence_reference: string;
    provider_payment_id?: string;
  };
}

export interface CommercialBackfillPlan {
  index: number;
  organization_name: string;
  site_license_id?: string;
  provenance?: {
    source: string;
    reference: string;
  };
  actions: Array<"create" | "approve" | "issue_invoice" | "record_payment">;
  ready: boolean;
  blockers: string[];
}

export interface CommercialBackfillRequest extends CommercialMutationRequest {
  candidates: CommercialBackfillCandidate[];
  commit?: boolean;
}

export interface CommercialBackfillResponse {
  preview: boolean;
  planned: CommercialBackfillPlan[];
  created: CommercialOrder[];
  skipped: Array<{ index: number; reason: string }>;
}

export type SiteLicenseRevenueMeasure = "contracted" | "invoiced" | "collected";

export interface SiteLicenseRevenueAnalyticsRequest extends CommercialReadRequest {
  start?: Date | string;
  end?: Date | string;
}

export interface SiteLicenseRevenueAnalyticsRow {
  day: string;
  measure: SiteLicenseRevenueMeasure;
  amount_cents: number;
  source_count: number;
}

export interface SiteLicenseRevenueAnalytics {
  checked_at: string;
  start: string;
  end: string;
  rows: SiteLicenseRevenueAnalyticsRow[];
}

export interface CommercialOrdersApi {
  list: (
    opts: CommercialOrderListRequest,
  ) => Promise<CommercialOrderListResponse>;
  get: (opts: CommercialOrderGetRequest) => Promise<CommercialOrder>;
  listAssignees: (
    opts: CommercialAssigneeListRequest,
  ) => Promise<UserSearchResult[]>;
  events: (
    opts: CommercialOrderEventsRequest,
  ) => Promise<CommercialOrderEventsResponse>;
  siteLicenseRevenueAnalytics: (
    opts: SiteLicenseRevenueAnalyticsRequest,
  ) => Promise<SiteLicenseRevenueAnalytics>;
  createPreview: (
    opts: CommercialOrderCreateRequest,
  ) => Promise<CommercialOrderCreatePreview>;
  create: (opts: CommercialOrderCreateRequest) => Promise<CommercialOrder>;
  update: (opts: CommercialOrderUpdateRequest) => Promise<CommercialOrder>;
  revise: (opts: CommercialOrderRevisionRequest) => Promise<CommercialOrder>;
  assign: (opts: CommercialOrderAssignRequest) => Promise<CommercialOrder>;
  addNote: (opts: CommercialOrderNoteRequest) => Promise<CommercialOrder>;
  updateBillingDetails: (
    opts: CommercialBillingDetailsUpdateRequest,
  ) => Promise<CommercialOrder>;
  updateCollectionMode: (
    opts: CommercialCollectionModeUpdateRequest,
  ) => Promise<CommercialOrder>;
  approve: (opts: CommercialOrderTransitionRequest) => Promise<CommercialOrder>;
  cancel: (opts: CommercialOrderTransitionRequest) => Promise<CommercialOrder>;
  quotePreview: (
    opts: CommercialQuotePreviewRequest,
  ) => Promise<CommercialQuotePreview>;
  issueQuote: (opts: CommercialQuoteIssueRequest) => Promise<CommercialOrder>;
  voidQuote: (opts: CommercialQuoteVoidRequest) => Promise<CommercialOrder>;
  quoteDocument: (
    opts: CommercialQuoteDocumentRequest,
  ) => Promise<CommercialQuoteDocument>;
  issueQuoteLink: (
    opts: CommercialQuoteLinkRequest,
  ) => Promise<CommercialQuoteLinkResult>;
  revokeQuoteLink: (
    opts: CommercialQuoteVoidRequest,
  ) => Promise<CommercialOrder>;
  stripeQuotePreview: (
    opts: CommercialStripeQuotePreviewRequest,
  ) => Promise<CommercialStripeQuotePreview>;
  createStripeQuote: (
    opts: CommercialStripeQuoteCreateRequest,
  ) => Promise<CommercialOrder>;
  finalizeStripeQuote: (
    opts: CommercialStripeQuoteMutationRequest,
  ) => Promise<CommercialOrder>;
  acceptStripeQuote: (
    opts: CommercialStripeQuoteAcceptRequest,
  ) => Promise<CommercialOrder>;
  cancelStripeQuote: (
    opts: CommercialStripeQuoteMutationRequest,
  ) => Promise<CommercialOrder>;
  reconcileStripeQuote: (
    opts: CommercialStripeQuoteMutationRequest,
  ) => Promise<CommercialOrder>;
  uploadDocument: (
    opts: CommercialOrderDocumentUploadRequest,
  ) => Promise<CommercialOrder>;
  voidDocument: (
    opts: CommercialOrderDocumentVoidRequest,
  ) => Promise<CommercialOrder>;
  downloadDocument: (
    opts: CommercialOrderDocumentDownloadRequest,
  ) => Promise<CommercialOrderDocumentDownload>;
  invoicePreview: (
    opts: CommercialInvoicePreviewRequest,
  ) => Promise<CommercialInvoicePreview>;
  createInvoiceDraft: (
    opts: CommercialInvoiceMutationRequest,
  ) => Promise<CommercialOrder>;
  linkExistingInvoice: (
    opts: CommercialInvoiceLinkRequest,
  ) => Promise<CommercialOrder>;
  sendInvoice: (
    opts: CommercialInvoiceMutationRequest,
  ) => Promise<CommercialOrder>;
  voidInvoice: (
    opts: CommercialInvoiceMutationRequest,
  ) => Promise<CommercialOrder>;
  reconcileInvoice: (
    opts: CommercialInvoiceMutationRequest,
  ) => Promise<CommercialOrder>;
  reconcilePreview: (
    opts: CommercialReconcilePreviewRequest,
  ) => Promise<CommercialReconcilePreview>;
  recordManualPayment: (
    opts: CommercialManualPaymentRequest,
  ) => Promise<CommercialOrder>;
  issueManualInvoice: (
    opts: CommercialManualInvoiceIssueRequest,
  ) => Promise<CommercialOrder>;
  fulfillmentPreview: (
    opts: CommercialFulfillmentPreviewRequest,
  ) => Promise<CommercialFulfillmentPlan>;
  provision: (opts: CommercialProvisionRequest) => Promise<CommercialOrder>;
  endFulfillment: (
    opts: CommercialOrderTransitionRequest,
  ) => Promise<CommercialOrder>;
  diagnostics: (
    opts: CommercialDiagnosticsRequest,
  ) => Promise<CommercialOrderDiagnostics>;
  retryStripeEvent: (
    opts: CommercialStripeEventRetryRequest,
  ) => Promise<CommercialStripeEventRetryResult>;
  backfill: (
    opts: CommercialBackfillRequest,
  ) => Promise<CommercialBackfillResponse>;
}

export const commercialOrders = {
  list: authFirstRequireAccount,
  get: authFirstRequireAccount,
  listAssignees: authFirstRequireAccount,
  events: authFirstRequireAccount,
  siteLicenseRevenueAnalytics: authFirstRequireAccount,
  createPreview: authFirstRequireAccount,
  create: authFirstRequireAccount,
  update: authFirstRequireAccount,
  revise: authFirstRequireAccount,
  assign: authFirstRequireAccount,
  addNote: authFirstRequireAccount,
  updateBillingDetails: authFirstRequireAccount,
  updateCollectionMode: authFirstRequireAccount,
  approve: authFirstRequireAccount,
  cancel: authFirstRequireAccount,
  quotePreview: authFirstRequireAccount,
  issueQuote: authFirstRequireAccount,
  voidQuote: authFirstRequireAccount,
  quoteDocument: authFirstRequireAccount,
  issueQuoteLink: authFirstRequireAccount,
  revokeQuoteLink: authFirstRequireAccount,
  stripeQuotePreview: authFirstRequireAccount,
  createStripeQuote: authFirstRequireAccount,
  finalizeStripeQuote: authFirstRequireAccount,
  acceptStripeQuote: authFirstRequireAccount,
  cancelStripeQuote: authFirstRequireAccount,
  reconcileStripeQuote: authFirstRequireAccount,
  uploadDocument: authFirstRequireAccount,
  voidDocument: authFirstRequireAccount,
  downloadDocument: authFirstRequireAccount,
  invoicePreview: authFirstRequireAccount,
  createInvoiceDraft: authFirstRequireAccount,
  linkExistingInvoice: authFirstRequireAccount,
  sendInvoice: authFirstRequireAccount,
  voidInvoice: authFirstRequireAccount,
  reconcileInvoice: authFirstRequireAccount,
  reconcilePreview: authFirstRequireAccount,
  recordManualPayment: authFirstRequireAccount,
  issueManualInvoice: authFirstRequireAccount,
  fulfillmentPreview: authFirstRequireAccount,
  provision: authFirstRequireAccount,
  endFulfillment: authFirstRequireAccount,
  diagnostics: authFirstRequireAccount,
  retryStripeEvent: authFirstRequireAccount,
  backfill: authFirstRequireAccount,
};
