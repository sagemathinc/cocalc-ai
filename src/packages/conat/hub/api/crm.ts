/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { CommercialOrder } from "@cocalc/util/commercial-orders";
import type {
  CrmContactSuppression,
  CrmOutreachBatch,
  CrmOutreachBatchDetail,
  CrmOutreachBatchState,
  CrmOutreachDelivery,
  CrmOutreachDeliveryState,
  CrmOutreachDiagnostics,
  CrmOutreachEngagementEvent,
  CrmOutreachFollowUpPolicy,
  CrmOutreachKind,
  CrmOutreachLimits,
  CrmOutreachProviderOperation,
  CrmOutreachSuppressionReason,
  CrmOutreachSuppressionScope,
  CrmOutreachTemplate,
  CrmOutreachTemplateState,
} from "@cocalc/util/crm-outreach";
import type {
  CrmActivity,
  CrmActivityKind,
  CrmBackfillCandidate,
  CrmCustomer360,
  CrmDailyDigest,
  CrmCustomerMetrics,
  CrmDiagnostics,
  CrmDomainKind,
  CrmDomainState,
  CrmExternalObjectKind,
  CrmExternalProvider,
  CrmExternalReference,
  CrmExternalReferenceListItem,
  CrmLifecycleStage,
  CrmMutationResult,
  CrmOpportunity,
  CrmOpportunityKind,
  CrmOpportunityStage,
  CrmOrganization,
  CrmOrganizationDomain,
  CrmOrganizationPerson,
  CrmOrganizationSummary,
  CrmOrganizationType,
  CrmPerson,
  CrmPersonAccount,
  CrmPersonEmail,
  CrmPersonRole,
  CrmSupportCustomerContext,
  CrmTask,
  CrmTaskPriority,
  CrmTaskState,
  CrmTaskType,
} from "@cocalc/util/crm";
import { authFirstRequireAccount } from "./util";

interface CrmAuthenticatedRequest {
  account_id?: string;
  browser_id?: string;
  session_hash?: string;
}

export interface CrmReadRequest extends CrmAuthenticatedRequest {
  reason: string;
}

export interface CrmMutationRequest extends CrmReadRequest {
  commit?: boolean;
  expected_version?: number;
  idempotency_key?: string;
  source?: "admin-ui" | "cli" | "migration" | "system";
}

export interface CrmPageRequest extends CrmReadRequest {
  cursor?: string;
  limit?: number;
  max_bytes?: number;
}

export interface CrmOrganizationQueueFilters {
  lifecycle_stages?: CrmLifecycleStage[];
  statuses?: Array<"active" | "merged" | "archived">;
  organization_types?: CrmOrganizationType[];
  opportunity_kinds?: CrmOpportunityKind[];
  include_won_active_site_license_offers?: boolean;
  owner_account_id?: string | null;
  has_overdue_tasks?: boolean;
  unassigned?: boolean;
}

export interface CrmOrganizationListRequest
  extends CrmPageRequest, CrmOrganizationQueueFilters {
  search?: string;
}

export interface CrmOrganizationListResponse {
  organizations: CrmOrganizationSummary[];
  next_cursor?: string;
  truncated: boolean;
  result_bytes: number;
}

export interface CrmOrganizationSearchRequest
  extends CrmPageRequest, CrmOrganizationQueueFilters {
  query?: string;
  domain?: string;
  email?: string;
  linked_account_id?: string;
  zendesk_ticket_id?: number;
  commercial_order?: string;
  site_license_id?: string;
}

export interface CrmExternalReferenceListRequest extends CrmPageRequest {
  provider?: CrmExternalProvider;
  object_kind?: CrmExternalObjectKind;
  external_id?: string;
  external_id_prefix?: string;
  organization?: string;
  verification_state?: CrmExternalReference["verification_state"];
}

export interface CrmExternalReferenceListResponse {
  external_references: CrmExternalReferenceListItem[];
  next_cursor?: string;
  truncated: boolean;
  result_bytes: number;
}

export interface CrmSupportContextRequest extends CrmReadRequest {
  ticket_id: number;
  requester_email?: string;
  requester_account_id?: string;
  limit?: number;
}

export interface CrmOrganizationGetRequest extends CrmReadRequest {
  organization: string;
  activity_limit?: number;
}

export interface CrmTimelineRequest extends CrmPageRequest {
  organization: string;
  kinds?: CrmActivityKind[];
}

export interface CrmTimelineResponse {
  activities: CrmActivity[];
  next_cursor?: string;
  truncated: boolean;
  result_bytes: number;
}

export interface CrmPersonListRequest extends CrmPageRequest {
  organization?: string;
  search?: string;
  status?: "active" | "merged" | "archived";
}

export interface CrmPersonListResponse {
  people: CrmPerson[];
  next_cursor?: string;
  truncated: boolean;
  result_bytes: number;
}

export interface CrmPersonGetRequest extends CrmReadRequest {
  person: string;
}

export interface CrmOpportunityListRequest extends CrmPageRequest {
  organization?: string;
  stages?: CrmOpportunityStage[];
  kinds?: CrmOpportunityKind[];
  owner_account_id?: string;
}

export interface CrmOpportunityListResponse {
  opportunities: CrmOpportunity[];
  next_cursor?: string;
  truncated: boolean;
  result_bytes: number;
}

export interface CrmOpportunityGetRequest extends CrmReadRequest {
  opportunity: string;
}

export interface CrmTaskListRequest extends CrmPageRequest {
  organization?: string;
  opportunity?: string;
  assignee_account_id?: string;
  states?: CrmTaskState[];
  types?: CrmTaskType[];
  due_before?: string;
  overdue?: boolean;
}

export interface CrmTaskListResponse {
  tasks: CrmTask[];
  next_cursor?: string;
  truncated: boolean;
  result_bytes: number;
}

export interface CrmTaskGetRequest extends CrmReadRequest {
  task: string;
}

export interface CrmMetricsRequest extends CrmReadRequest {
  organization: string;
  refresh?: boolean;
}

export interface CrmDiagnosticsRequest extends CrmReadRequest {
  limit?: number;
}

export interface CrmDailyDigestRequest extends CrmReadRequest {
  as_of?: string;
  due_within_days?: number;
  renewal_within_days?: number;
  assignee_account_id?: string;
  limit?: number;
}

export interface CrmExportRequest extends CrmPageRequest {
  organization?: string;
  include_people?: boolean;
  include_activities?: boolean;
}

export interface CrmExportResponse {
  schema_version: typeof import("@cocalc/util/crm").CRM_SCHEMA_CONTRACT_VERSION;
  generated_at: string;
  sensitive: true;
  organizations: CrmCustomer360[];
  truncated: boolean;
  result_bytes: number;
}

export interface CrmOrganizationCreateRequest extends CrmMutationRequest {
  display_name: string;
  legal_name?: string;
  aliases?: string[];
  website?: string;
  timezone?: string;
  organization_type: CrmOrganizationType;
  lifecycle_stage?: CrmLifecycleStage;
  relationship_owner_account_id?: string;
  parent_organization?: string;
}

export interface CrmOrganizationUpdateRequest extends CrmMutationRequest {
  organization: string;
  changes: Partial<
    Pick<
      CrmOrganization,
      | "display_name"
      | "legal_name"
      | "aliases"
      | "website"
      | "timezone"
      | "organization_type"
      | "lifecycle_stage"
      | "relationship_owner_account_id"
      | "parent_organization_id"
    >
  >;
}

export interface CrmOrganizationArchiveRequest extends CrmMutationRequest {
  organization: string;
}

export interface CrmOrganizationMergeRequest extends CrmMutationRequest {
  source_organization: string;
  destination_organization: string;
}

export interface CrmDomainMutationRequest extends CrmMutationRequest {
  organization: string;
  domain: string;
  action: "add" | "verify" | "reject" | "retire" | "transfer";
  kind?: CrmDomainKind;
  state?: CrmDomainState;
  destination_organization?: string;
  verification_method?: string;
  evidence_reference?: string;
}

export interface CrmPersonCreateRequest extends CrmMutationRequest {
  display_name: string;
  website?: string;
  linkedin_url?: string;
  facebook_url?: string;
  x_url?: string;
  note?: string;
  timezone?: string;
  organization?: string;
  roles?: CrmPersonRole[];
  title?: string;
  department?: string;
  email?: string;
  cocalc_account_id?: string;
}

export interface CrmPersonUpdateRequest extends CrmMutationRequest {
  person: string;
  changes: Partial<
    Pick<
      CrmPerson,
      | "display_name"
      | "website"
      | "linkedin_url"
      | "facebook_url"
      | "x_url"
      | "note"
      | "timezone"
      | "status"
    >
  >;
}

export interface CrmPersonEmailMutationRequest extends CrmMutationRequest {
  person: string;
  email: string;
  action: "add" | "update" | "remove";
  kind?: CrmPersonEmail["kind"];
  is_primary?: boolean;
  verified?: boolean;
}

export interface CrmPersonAccountMutationRequest extends CrmMutationRequest {
  person: string;
  linked_account_id: string;
  action: "link" | "verify" | "reject" | "retire" | "unlink";
  evidence_reference?: string;
}

export interface CrmOrganizationPersonMutationRequest extends CrmMutationRequest {
  organization: string;
  person: string;
  action: "link" | "update" | "unlink";
  roles?: CrmPersonRole[];
  title?: string;
  department?: string;
  state?: CrmOrganizationPerson["state"];
}

export interface CrmOpportunityCreateRequest extends CrmMutationRequest {
  organization: string;
  name: string;
  kind: CrmOpportunityKind;
  owner_account_id: string;
  expected_value: string;
  currency?: string;
  expected_close_date: string;
  service_starts_at?: string;
  service_ends_at?: string;
  source_zendesk_ticket_ids?: number[];
  description?: string;
}

export interface CrmOpportunityUpdateRequest extends CrmMutationRequest {
  opportunity: string;
  changes: Partial<
    Pick<
      CrmOpportunity,
      | "name"
      | "kind"
      | "owner_account_id"
      | "expected_value"
      | "currency"
      | "expected_close_date"
      | "service_starts_at"
      | "service_ends_at"
      | "source_zendesk_ticket_ids"
      | "description"
    >
  >;
}

export interface CrmOpportunityTransitionRequest extends CrmMutationRequest {
  opportunity: string;
  stage: CrmOpportunityStage;
  loss_reason?: string;
}

export interface CrmTaskCreateRequest extends CrmMutationRequest {
  organization: string;
  person?: string;
  opportunity?: string;
  commercial_order_id?: string;
  zendesk_ticket_id?: number;
  type: CrmTaskType;
  assignee_account_id: string;
  due_at: string;
  priority?: CrmTaskPriority;
  subject: string;
  details?: string;
}

export interface CrmTaskUpdateRequest extends CrmMutationRequest {
  task: string;
  changes: Partial<
    Pick<
      CrmTask,
      | "type"
      | "assignee_account_id"
      | "due_at"
      | "priority"
      | "subject"
      | "details"
    >
  >;
}

export interface CrmTaskTransitionRequest extends CrmMutationRequest {
  task: string;
  action: "assign" | "reschedule" | "complete" | "cancel";
  assignee_account_id?: string;
  due_at?: string;
}

export interface CrmActivityCreateRequest extends CrmMutationRequest {
  organization: string;
  kind: "note" | "call" | "meeting";
  summary: string;
  details?: string;
  person?: string;
  opportunity?: string;
  task?: string;
  occurred_at: string;
  supersedes_activity_id?: string;
}

export interface CrmExternalReferenceMutationRequest extends CrmMutationRequest {
  organization: string;
  action: "add" | "verify" | "reject" | "remove";
  provider: CrmExternalProvider;
  object_kind: CrmExternalObjectKind;
  external_id: string;
  person?: string;
  opportunity?: string;
  label?: string;
  metadata?: Record<string, unknown>;
}

export interface CrmOrderFromOpportunityRequest extends CrmMutationRequest {
  opportunity: string;
  next_action: string;
  next_action_due_at?: string;
  collection_mode?: "stripe_invoice" | "manual_invoice";
  payment_terms_days?: number;
  billing_contact_person?: string;
}

export interface CrmBackfillRequest extends CrmMutationRequest {
  candidate_keys?: string[];
  limit?: number;
}

export interface CrmBackfillResponse {
  preview: boolean;
  replayed?: boolean;
  audit_id?: string;
  candidates: CrmBackfillCandidate[];
  created: CrmOrganization[];
  skipped: Array<{ candidate_key: string; reason: string }>;
}

export interface CrmOutreachTemplateListRequest extends CrmPageRequest {
  template_key?: string;
  kind?: CrmOutreachKind;
  status?: CrmOutreachTemplateState;
}

export interface CrmOutreachTemplateListResponse {
  templates: CrmOutreachTemplate[];
  truncated: boolean;
}

export interface CrmOutreachTemplateGetRequest extends CrmReadRequest {
  template: string;
}

export interface CrmOutreachTemplateCreateRequest extends CrmMutationRequest {
  template_key: string;
  name: string;
  kind: CrmOutreachKind;
  subject_template: string;
  body_markdown_template: string;
  required_fields?: string[];
  follow_up_policy?: CrmOutreachFollowUpPolicy;
  follow_up_after_days?: number;
  max_followups?: number;
  final_review_after_days?: number;
  revise_from?: string;
}

export interface CrmOutreachTemplateTransitionRequest extends CrmMutationRequest {
  template: string;
  action: "activate" | "retire";
}

export interface CrmOutreachBatchListRequest extends CrmPageRequest {
  states?: CrmOutreachBatchState[];
  kinds?: CrmOutreachKind[];
  owner_account_id?: string;
  organization?: string;
  zendesk_ticket_id?: number;
}

export interface CrmOutreachBatchListResponse {
  batches: CrmOutreachBatch[];
  truncated: boolean;
}

export interface CrmOutreachBatchGetRequest extends CrmReadRequest {
  batch: string;
}

export interface CrmOutreachDeliveryListRequest extends CrmPageRequest {
  batch?: string;
  organization?: string;
  person?: string;
  opportunity?: string;
  states?: CrmOutreachDeliveryState[];
  zendesk_ticket_id?: number;
  engagement?: "viewed" | "unviewed" | "replied" | "unreplied";
  suggested_action?: string;
}

export interface CrmOutreachDeliveryListResponse {
  deliveries: CrmOutreachDelivery[];
  truncated: boolean;
}

export interface CrmOutreachDeliveryGetRequest extends CrmReadRequest {
  delivery: string;
}

export interface CrmOutreachBatchCreateRequest extends CrmMutationRequest {
  name: string;
  purpose: string;
  kind: CrmOutreachKind;
  owner_account_id: string;
  template?: string;
}

export interface CrmOutreachBatchUpdateRequest extends CrmMutationRequest {
  batch: string;
  changes: Partial<
    Pick<CrmOutreachBatch, "name" | "purpose" | "owner_account_id">
  >;
}

export interface CrmOutreachRecipientRequest extends CrmMutationRequest {
  batch: string;
  person: string;
  organization?: string;
  opportunity?: string;
  email?: string;
  subject?: string;
  body_markdown?: string;
  override_reason?: string;
}

export interface CrmOutreachRecipientRemoveRequest extends CrmMutationRequest {
  batch: string;
  delivery: string;
}

export interface CrmOutreachBatchTransitionRequest extends CrmMutationRequest {
  batch: string;
  action: "approve" | "queue" | "pause" | "resume" | "cancel";
}

export interface CrmOutreachDeliveryActionRequest extends CrmMutationRequest {
  delivery: string;
  action: "retry" | "reconcile" | "cancel";
}

export interface CrmOutreachPreviewRequest extends CrmReadRequest {
  batch: string;
}

export interface CrmOutreachPreview {
  batch: CrmOutreachBatch;
  deliveries: Array<{
    delivery: CrmOutreachDelivery;
    blocking_errors: string[];
    warnings: string[];
  }>;
  effective_limits: CrmOutreachLimits;
  provider_routing: {
    support_address?: string;
    submitter_id?: string;
    group_id?: string;
    form_id?: string;
  };
  can_approve: boolean;
  can_queue: boolean;
}

export interface CrmContactSuppressionListRequest extends CrmPageRequest {
  organization?: string;
  person?: string;
  active?: boolean;
  scope?: CrmOutreachSuppressionScope;
  search?: string;
}

export interface CrmContactSuppressionListResponse {
  suppressions: CrmContactSuppression[];
  truncated: boolean;
}

export interface CrmContactSuppressionMutationRequest extends CrmMutationRequest {
  action: "add" | "revoke";
  suppression?: string;
  scope?: CrmOutreachSuppressionScope;
  value?: string;
  organization?: string;
  person?: string;
  email?: string;
  suppression_reason?: CrmOutreachSuppressionReason;
  note?: string;
}

export interface CrmOutreachLimitsRequest extends CrmReadRequest {
  domain?: string;
}

export interface CrmOutreachDiagnosticsRequest extends CrmReadRequest {}

export interface CrmOutreachEngagementListRequest extends CrmPageRequest {
  delivery: string;
}

export interface CrmOutreachEngagementListResponse {
  events: CrmOutreachEngagementEvent[];
  truncated: boolean;
}

export interface CrmOutreachProviderOperationListRequest extends CrmPageRequest {
  delivery: string;
}

export interface CrmOutreachProviderOperationListResponse {
  operations: CrmOutreachProviderOperation[];
  truncated: boolean;
}

export interface CrmOutreachFollowUpListRequest extends CrmPageRequest {
  organization?: string;
  opportunity?: string;
  assignee_account_id?: string;
  due_before?: string;
  overdue?: boolean;
  viewed?: boolean;
  replied?: boolean;
}

export interface CrmOutreachFollowUp {
  delivery: CrmOutreachDelivery;
  task: CrmTask;
  organization: Pick<
    CrmOrganization,
    "id" | "customer_number" | "display_name"
  >;
  support_show_command: string;
  follow_up_command: string;
}

export interface CrmOutreachFollowUpListResponse {
  followups: CrmOutreachFollowUp[];
  truncated: boolean;
}

export interface CrmOutreachFollowUpPreviewRequest extends CrmReadRequest {
  delivery: string;
  body?: string;
}

export interface CrmOutreachFollowUpPreview {
  delivery: CrmOutreachDelivery;
  body: string;
  zendesk_ticket_id: number;
  next_due_at: string;
  final_review: boolean;
  warnings: string[];
}

export interface CrmOutreachFollowUpSendRequest extends CrmMutationRequest {
  delivery: string;
  body: string;
}

export interface CrmOutreachSyncRequest extends CrmMutationRequest {
  delivery: string;
}

export interface AdminCrmApi {
  listOrganizations: (
    opts: CrmOrganizationListRequest,
  ) => Promise<CrmOrganizationListResponse>;
  searchOrganizations: (
    opts: CrmOrganizationSearchRequest,
  ) => Promise<CrmOrganizationListResponse>;
  getSupportContext: (
    opts: CrmSupportContextRequest,
  ) => Promise<CrmSupportCustomerContext>;
  getOrganization: (opts: CrmOrganizationGetRequest) => Promise<CrmCustomer360>;
  getCustomerTimeline: (
    opts: CrmTimelineRequest,
  ) => Promise<CrmTimelineResponse>;
  listExternalReferences: (
    opts: CrmExternalReferenceListRequest,
  ) => Promise<CrmExternalReferenceListResponse>;
  listPeople: (opts: CrmPersonListRequest) => Promise<CrmPersonListResponse>;
  searchPeople: (opts: CrmPersonListRequest) => Promise<CrmPersonListResponse>;
  getPerson: (opts: CrmPersonGetRequest) => Promise<CrmPerson>;
  listOpportunities: (
    opts: CrmOpportunityListRequest,
  ) => Promise<CrmOpportunityListResponse>;
  getOpportunity: (opts: CrmOpportunityGetRequest) => Promise<CrmOpportunity>;
  listTasks: (opts: CrmTaskListRequest) => Promise<CrmTaskListResponse>;
  getTask: (opts: CrmTaskGetRequest) => Promise<CrmTask>;
  getCustomerMetrics: (opts: CrmMetricsRequest) => Promise<CrmCustomerMetrics>;
  getDiagnostics: (opts: CrmDiagnosticsRequest) => Promise<CrmDiagnostics>;
  getDailyDigest: (opts: CrmDailyDigestRequest) => Promise<CrmDailyDigest>;
  exportData: (opts: CrmExportRequest) => Promise<CrmExportResponse>;
  createOrganization: (
    opts: CrmOrganizationCreateRequest,
  ) => Promise<CrmMutationResult<CrmOrganization>>;
  updateOrganization: (
    opts: CrmOrganizationUpdateRequest,
  ) => Promise<CrmMutationResult<CrmOrganization>>;
  archiveOrganization: (
    opts: CrmOrganizationArchiveRequest,
  ) => Promise<CrmMutationResult<CrmOrganization>>;
  mergeOrganizations: (
    opts: CrmOrganizationMergeRequest,
  ) => Promise<CrmMutationResult<CrmOrganization>>;
  mutateDomain: (
    opts: CrmDomainMutationRequest,
  ) => Promise<CrmMutationResult<CrmOrganizationDomain>>;
  createPerson: (
    opts: CrmPersonCreateRequest,
  ) => Promise<CrmMutationResult<CrmPerson>>;
  updatePerson: (
    opts: CrmPersonUpdateRequest,
  ) => Promise<CrmMutationResult<CrmPerson>>;
  mutatePersonEmail: (
    opts: CrmPersonEmailMutationRequest,
  ) => Promise<CrmMutationResult<CrmPersonEmail>>;
  mutatePersonAccount: (
    opts: CrmPersonAccountMutationRequest,
  ) => Promise<CrmMutationResult<CrmPersonAccount>>;
  mutateOrganizationPerson: (
    opts: CrmOrganizationPersonMutationRequest,
  ) => Promise<CrmMutationResult<CrmOrganizationPerson>>;
  createOpportunity: (
    opts: CrmOpportunityCreateRequest,
  ) => Promise<CrmMutationResult<CrmOpportunity>>;
  updateOpportunity: (
    opts: CrmOpportunityUpdateRequest,
  ) => Promise<CrmMutationResult<CrmOpportunity>>;
  transitionOpportunity: (
    opts: CrmOpportunityTransitionRequest,
  ) => Promise<CrmMutationResult<CrmOpportunity>>;
  createTask: (
    opts: CrmTaskCreateRequest,
  ) => Promise<CrmMutationResult<CrmTask>>;
  updateTask: (
    opts: CrmTaskUpdateRequest,
  ) => Promise<CrmMutationResult<CrmTask>>;
  transitionTask: (
    opts: CrmTaskTransitionRequest,
  ) => Promise<CrmMutationResult<CrmTask>>;
  addActivity: (
    opts: CrmActivityCreateRequest,
  ) => Promise<CrmMutationResult<CrmActivity>>;
  mutateExternalReference: (
    opts: CrmExternalReferenceMutationRequest,
  ) => Promise<CrmMutationResult<CrmExternalReference>>;
  createCommercialOrderFromOpportunity: (
    opts: CrmOrderFromOpportunityRequest,
  ) => Promise<CrmMutationResult<CommercialOrder>>;
  backfill: (opts: CrmBackfillRequest) => Promise<CrmBackfillResponse>;
  listOutreachTemplates: (
    opts: CrmOutreachTemplateListRequest,
  ) => Promise<CrmOutreachTemplateListResponse>;
  getOutreachTemplate: (
    opts: CrmOutreachTemplateGetRequest,
  ) => Promise<CrmOutreachTemplate>;
  listOutreachBatches: (
    opts: CrmOutreachBatchListRequest,
  ) => Promise<CrmOutreachBatchListResponse>;
  getOutreachBatch: (
    opts: CrmOutreachBatchGetRequest,
  ) => Promise<CrmOutreachBatchDetail>;
  listOutreachDeliveries: (
    opts: CrmOutreachDeliveryListRequest,
  ) => Promise<CrmOutreachDeliveryListResponse>;
  getOutreachDelivery: (
    opts: CrmOutreachDeliveryGetRequest,
  ) => Promise<CrmOutreachDelivery>;
  listOutreachProviderOperations: (
    opts: CrmOutreachProviderOperationListRequest,
  ) => Promise<CrmOutreachProviderOperationListResponse>;
  previewOutreachBatch: (
    opts: CrmOutreachPreviewRequest,
  ) => Promise<CrmOutreachPreview>;
  listContactSuppressions: (
    opts: CrmContactSuppressionListRequest,
  ) => Promise<CrmContactSuppressionListResponse>;
  getOutreachLimits: (
    opts: CrmOutreachLimitsRequest,
  ) => Promise<CrmOutreachLimits>;
  getOutreachDiagnostics: (
    opts: CrmOutreachDiagnosticsRequest,
  ) => Promise<CrmOutreachDiagnostics>;
  listOutreachEngagementEvents: (
    opts: CrmOutreachEngagementListRequest,
  ) => Promise<CrmOutreachEngagementListResponse>;
  listOutreachFollowups: (
    opts: CrmOutreachFollowUpListRequest,
  ) => Promise<CrmOutreachFollowUpListResponse>;
  previewOutreachFollowup: (
    opts: CrmOutreachFollowUpPreviewRequest,
  ) => Promise<CrmOutreachFollowUpPreview>;
  createOutreachTemplate: (
    opts: CrmOutreachTemplateCreateRequest,
  ) => Promise<CrmMutationResult<CrmOutreachTemplate>>;
  transitionOutreachTemplate: (
    opts: CrmOutreachTemplateTransitionRequest,
  ) => Promise<CrmMutationResult<CrmOutreachTemplate>>;
  createOutreachBatch: (
    opts: CrmOutreachBatchCreateRequest,
  ) => Promise<CrmMutationResult<CrmOutreachBatch>>;
  updateOutreachBatch: (
    opts: CrmOutreachBatchUpdateRequest,
  ) => Promise<CrmMutationResult<CrmOutreachBatch>>;
  addOutreachRecipient: (
    opts: CrmOutreachRecipientRequest,
  ) => Promise<CrmMutationResult<CrmOutreachDelivery>>;
  removeOutreachRecipient: (
    opts: CrmOutreachRecipientRemoveRequest,
  ) => Promise<CrmMutationResult<CrmOutreachDelivery>>;
  transitionOutreachBatch: (
    opts: CrmOutreachBatchTransitionRequest,
  ) => Promise<CrmMutationResult<CrmOutreachBatchDetail>>;
  mutateOutreachDelivery: (
    opts: CrmOutreachDeliveryActionRequest,
  ) => Promise<CrmMutationResult<CrmOutreachDelivery>>;
  mutateContactSuppression: (
    opts: CrmContactSuppressionMutationRequest,
  ) => Promise<CrmMutationResult<CrmContactSuppression>>;
  sendOutreachFollowup: (
    opts: CrmOutreachFollowUpSendRequest,
  ) => Promise<CrmMutationResult<CrmOutreachDelivery>>;
  syncOutreachDelivery: (
    opts: CrmOutreachSyncRequest,
  ) => Promise<CrmMutationResult<CrmOutreachDelivery>>;
}

export const adminCrm = {
  listOrganizations: authFirstRequireAccount,
  searchOrganizations: authFirstRequireAccount,
  getSupportContext: authFirstRequireAccount,
  getOrganization: authFirstRequireAccount,
  getCustomerTimeline: authFirstRequireAccount,
  listExternalReferences: authFirstRequireAccount,
  listPeople: authFirstRequireAccount,
  searchPeople: authFirstRequireAccount,
  getPerson: authFirstRequireAccount,
  listOpportunities: authFirstRequireAccount,
  getOpportunity: authFirstRequireAccount,
  listTasks: authFirstRequireAccount,
  getTask: authFirstRequireAccount,
  getCustomerMetrics: authFirstRequireAccount,
  getDiagnostics: authFirstRequireAccount,
  getDailyDigest: authFirstRequireAccount,
  exportData: authFirstRequireAccount,
  createOrganization: authFirstRequireAccount,
  updateOrganization: authFirstRequireAccount,
  archiveOrganization: authFirstRequireAccount,
  mergeOrganizations: authFirstRequireAccount,
  mutateDomain: authFirstRequireAccount,
  createPerson: authFirstRequireAccount,
  updatePerson: authFirstRequireAccount,
  mutatePersonEmail: authFirstRequireAccount,
  mutatePersonAccount: authFirstRequireAccount,
  mutateOrganizationPerson: authFirstRequireAccount,
  createOpportunity: authFirstRequireAccount,
  updateOpportunity: authFirstRequireAccount,
  transitionOpportunity: authFirstRequireAccount,
  createTask: authFirstRequireAccount,
  updateTask: authFirstRequireAccount,
  transitionTask: authFirstRequireAccount,
  addActivity: authFirstRequireAccount,
  mutateExternalReference: authFirstRequireAccount,
  createCommercialOrderFromOpportunity: authFirstRequireAccount,
  backfill: authFirstRequireAccount,
  listOutreachTemplates: authFirstRequireAccount,
  getOutreachTemplate: authFirstRequireAccount,
  listOutreachBatches: authFirstRequireAccount,
  getOutreachBatch: authFirstRequireAccount,
  listOutreachDeliveries: authFirstRequireAccount,
  getOutreachDelivery: authFirstRequireAccount,
  listOutreachProviderOperations: authFirstRequireAccount,
  previewOutreachBatch: authFirstRequireAccount,
  listContactSuppressions: authFirstRequireAccount,
  getOutreachLimits: authFirstRequireAccount,
  getOutreachDiagnostics: authFirstRequireAccount,
  listOutreachEngagementEvents: authFirstRequireAccount,
  listOutreachFollowups: authFirstRequireAccount,
  previewOutreachFollowup: authFirstRequireAccount,
  createOutreachTemplate: authFirstRequireAccount,
  transitionOutreachTemplate: authFirstRequireAccount,
  createOutreachBatch: authFirstRequireAccount,
  updateOutreachBatch: authFirstRequireAccount,
  addOutreachRecipient: authFirstRequireAccount,
  removeOutreachRecipient: authFirstRequireAccount,
  transitionOutreachBatch: authFirstRequireAccount,
  mutateOutreachDelivery: authFirstRequireAccount,
  mutateContactSuppression: authFirstRequireAccount,
  sendOutreachFollowup: authFirstRequireAccount,
  syncOutreachDelivery: authFirstRequireAccount,
};
