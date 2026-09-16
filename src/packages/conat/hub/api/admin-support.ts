/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { authFirstRequireAccount } from "./util";
import type { CrmSupportCustomerContext } from "@cocalc/util/crm";

export const ADMIN_SUPPORT_TICKET_STATUSES = [
  "new",
  "open",
  "pending",
  "hold",
  "solved",
  "closed",
] as const;

export type AdminSupportTicketStatus =
  (typeof ADMIN_SUPPORT_TICKET_STATUSES)[number];

export const ADMIN_SUPPORT_MUTABLE_TICKET_STATUSES = [
  "new",
  "open",
  "pending",
  "hold",
  "solved",
] as const;

export type AdminSupportMutableTicketStatus =
  (typeof ADMIN_SUPPORT_MUTABLE_TICKET_STATUSES)[number];

export const ADMIN_SUPPORT_TICKET_PRIORITIES = [
  "low",
  "normal",
  "high",
  "urgent",
] as const;

export type AdminSupportTicketPriority =
  (typeof ADMIN_SUPPORT_TICKET_PRIORITIES)[number];

export const ADMIN_SUPPORT_CATEGORIES = [
  "availability",
  "performance",
  "project_start",
  "files",
  "terminal",
  "codex",
  "jupyter",
  "billing",
  "account_access",
  "abuse_security",
  "bug",
  "how_to",
  "other",
] as const;

export type AdminSupportCategory = (typeof ADMIN_SUPPORT_CATEGORIES)[number];

export interface AdminSupportTicketSignals {
  categories: AdminSupportCategory[];
  error_signatures: string[];
}

export interface AdminSupportTicketSummary {
  id: number;
  agent_url: string;
  status: AdminSupportTicketStatus | "unknown";
  type?: string;
  priority?: string;
  assignee_id?: number | null;
  tags: string[];
  subject: string;
  description_preview: string;
  created_at: string;
  updated_at: string;
  account_fingerprint?: string;
  project_ids: string[];
  signals: AdminSupportTicketSignals;
}

export interface AdminSupportImageReference {
  filename: string;
  source: "cocalc_blob" | "zendesk_attachment";
  url?: string;
  attachment_id?: number;
  content_type?: string;
  size?: number;
  inline?: boolean;
}

export interface AdminSupportTicketComment {
  id: number;
  author: "requester" | "staff_or_system";
  public: boolean;
  created_at: string;
  body: string;
  images: AdminSupportImageReference[];
  /** Downloadable Zendesk attachments; names are generated, URLs omitted. */
  attachments?: AdminSupportAttachmentReference[];
  attachment_count: number;
  attachment_bytes: number;
}

export interface AdminSupportAttachmentReference {
  attachment_id: number;
  filename: string;
  content_type: string;
  size: number;
}

export interface AdminSupportListRequest {
  since_minutes?: number;
  limit?: number;
  statuses?: AdminSupportTicketStatus[];
  max_bytes?: number;
  reason: string;
}

export interface AdminSupportListResponse {
  audit_id: string;
  server_time: string;
  since: string;
  statuses: AdminSupportTicketStatus[];
  tickets: AdminSupportTicketSummary[];
  source_candidates: number;
  result_bytes: number;
  truncated: boolean;
  redaction: "best_effort";
}

export interface AdminSupportShowRequest {
  ticket_id: number;
  max_comments?: number;
  max_bytes?: number;
  reason: string;
}

export interface AdminSupportShowResponse {
  audit_id: string;
  server_time: string;
  ticket: AdminSupportTicketSummary & {
    description: string;
    images: AdminSupportImageReference[];
  };
  comments: AdminSupportTicketComment[];
  crm_context?: CrmSupportCustomerContext;
  result_bytes: number;
  truncated: boolean;
  redaction: "best_effort";
}

export interface AdminSupportGetImageRequest {
  ticket_id: number;
  attachment_id: number;
  max_bytes?: number;
  reason: string;
}

export interface AdminSupportGetImageResponse {
  audit_id: string;
  ticket_id: number;
  comment_id: number;
  attachment_id: number;
  filename: string;
  content_type: string;
  size: number;
  sha256: string;
  data_base64: string;
}

export type AdminSupportGetAttachmentRequest = AdminSupportGetImageRequest;
export type AdminSupportGetAttachmentResponse = AdminSupportGetImageResponse;

export interface AdminSupportTriageRequest extends AdminSupportListRequest {}

export interface AdminSupportTriageGroup {
  key: string;
  reason: "error_signature" | "subject_similarity" | "category";
  category: AdminSupportCategory;
  ticket_ids: number[];
  count: number;
  first_created_at: string;
  last_updated_at: string;
  project_ids: string[];
  error_signatures: string[];
  subjects: string[];
}

export interface AdminSupportTriageResponse extends Omit<
  AdminSupportListResponse,
  "tickets"
> {
  tickets: AdminSupportTicketSummary[];
  category_counts: Partial<Record<AdminSupportCategory, number>>;
  groups: AdminSupportTriageGroup[];
}

export interface AdminSupportSearchRequest {
  query: string;
  limit?: number;
  max_bytes?: number;
  reason: string;
}

export interface AdminSupportSearchResponse {
  audit_id: string;
  server_time: string;
  query: string;
  tickets: AdminSupportTicketSummary[];
  source_candidates: number;
  result_bytes: number;
  truncated: boolean;
  redaction: "best_effort";
  indexing_note: string;
}

export interface AdminSupportUpdateChanges {
  public_reply?: string;
  private_note?: string;
  status?: AdminSupportMutableTicketStatus;
  priority?: AdminSupportTicketPriority | null;
  assignee_id?: number | null;
  add_tags?: string[];
  remove_tags?: string[];
}

export interface AdminSupportUpdatePlanRequest extends AdminSupportUpdateChanges {
  ticket_id: number;
  expected_updated_at?: string;
  reason: string;
}

export interface AdminSupportMutationPreview {
  comment_kind?: "public_reply" | "private_note";
  comment_chars?: number;
  comment_sha256?: string;
  comment_preview?: string;
  status?: AdminSupportMutableTicketStatus;
  priority?: AdminSupportTicketPriority | null;
  assignee_id?: number | null;
  add_tags: string[];
  remove_tags: string[];
}

export interface AdminSupportUpdatePlanResponse {
  audit_id: string;
  operation: "update";
  commit: false;
  payload_hash: string;
  expected_updated_at: string;
  ticket_before: AdminSupportTicketSummary;
  changes: AdminSupportMutationPreview;
}

export interface AdminSupportUpdateRequest extends AdminSupportUpdatePlanRequest {
  expected_updated_at: string;
  idempotency_key: string;
  timeout?: number;
}

export interface AdminSupportUpdateResponse {
  audit_id: string;
  operation: "update";
  commit: true;
  payload_hash: string;
  idempotency_key: string;
  idempotent_replay: boolean;
  zendesk_audit_id?: number;
  comment?: AdminSupportAppliedComment;
  ticket: AdminSupportTicketSummary;
}

export interface AdminSupportAppliedComment {
  id: number;
  public: boolean;
  created_at: string;
  body_sha256: string;
  body_preview: string;
}

export interface AdminSupportMergePlanRequest {
  target_ticket_id: number;
  source_ticket_id: number;
  target_comment?: string;
  source_comment?: string;
  target_comment_public?: boolean;
  source_comment_public?: boolean;
  target_expected_updated_at?: string;
  source_expected_updated_at?: string;
  reason: string;
}

export interface AdminSupportMergePlanResponse {
  audit_id: string;
  operation: "merge";
  commit: false;
  payload_hash: string;
  target_expected_updated_at: string;
  source_expected_updated_at: string;
  target_ticket: AdminSupportTicketSummary;
  source_ticket: AdminSupportTicketSummary;
  target_comment?: AdminSupportMutationPreview;
  source_comment?: AdminSupportMutationPreview;
}

export interface AdminSupportMergeRequest extends AdminSupportMergePlanRequest {
  target_expected_updated_at: string;
  source_expected_updated_at: string;
  idempotency_key: string;
  timeout?: number;
}

export interface AdminSupportMergeResponse {
  audit_id: string;
  operation: "merge";
  commit: true;
  payload_hash: string;
  idempotency_key: string;
  idempotent_replay: boolean;
  zendesk_job_id?: string;
  zendesk_job_status: string;
  target_ticket: AdminSupportTicketSummary;
  source_ticket: AdminSupportTicketSummary;
}

export interface AdminSupportSpamPlanRequest {
  ticket_id: number;
  expected_updated_at?: string;
  reason: string;
}

export interface AdminSupportSpamPlanResponse {
  audit_id: string;
  operation: "spam";
  commit: false;
  payload_hash: string;
  expected_updated_at: string;
  ticket_before: AdminSupportTicketSummary;
  warning: string;
}

export interface AdminSupportSpamRequest extends AdminSupportSpamPlanRequest {
  expected_updated_at: string;
  idempotency_key: string;
  timeout?: number;
}

export interface AdminSupportSpamResponse {
  audit_id: string;
  operation: "spam";
  commit: true;
  payload_hash: string;
  idempotency_key: string;
  idempotent_replay: boolean;
  ticket_id: number;
  requester_suspended: boolean;
  disposition: "deleted_as_spam" | "solved_and_tagged";
  fallback_reason?: string;
  ticket?: AdminSupportTicketSummary;
  zendesk_job_id?: string;
  zendesk_job_status: string;
}

export const ADMIN_SUPPORT_CONVENTIONS = {
  version: 2,
  statuses: {
    new: "We have not reviewed or acted on the ticket.",
    open: "CoCalc is actively investigating or still owes work, including after an interim reply.",
    pending:
      "CoCalc is waiting for the requester to answer a question or complete an action.",
    hold: "Work is blocked on a specific internal or external dependency.",
    solved:
      "The promised work is complete and verified; no further action is expected.",
    closed:
      "Zendesk's terminal state. Do not use it as a normal operator transition.",
  },
  workflow: [
    "Triage and investigate using read-only, audited commands.",
    "Draft the exact public reply or private note and proposed ticket changes.",
    "Obtain explicit human approval before any reply, status change, merge, or spam action.",
    "For multiline comments, write the approved text to a file and use --file, --public-reply-file, --private-note-file, --target-comment-file, or --source-comment-file. Do not pass JSON-escaped \\n sequences as inline text.",
    "Re-read the ticket and use expected_updated_at immediately before committing.",
    "Verify the resulting comment, status, audit, or asynchronous job after mutation.",
  ],
  handling: [
    "Inspect relevant screenshots and attachments before drawing conclusions from an incomplete description.",
    "Use open, not pending, when CoCalc still owns the next action.",
    "Use pending only when the requester must respond or act.",
    "Do not mark solved merely because a fix was committed; complete and verify the promised operational action first.",
    "Merge duplicates only after explicit approval, keeping the more complete or canonical ticket as the target.",
    "Mark spam only for clear unsolicited junk. Zendesk spam handling deletes the ticket and suspends the requester; if Zendesk definitively rejects that action, CoCalc instead solves and tags the ticket without replying and reports that the requester was not suspended.",
    "Limit account and project inspection to data relevant to the support request, use a ticket-specific audit reason, and never expose secrets or unnecessary personal data in replies.",
  ],
} as const;

export const adminSupport = {
  list: authFirstRequireAccount,
  show: authFirstRequireAccount,
  triage: authFirstRequireAccount,
  search: authFirstRequireAccount,
  getImage: authFirstRequireAccount,
  getAttachment: authFirstRequireAccount,
  planUpdate: authFirstRequireAccount,
  update: authFirstRequireAccount,
  planMerge: authFirstRequireAccount,
  merge: authFirstRequireAccount,
  planSpam: authFirstRequireAccount,
  spam: authFirstRequireAccount,
};

export interface AdminSupportApi {
  list: (opts: AdminSupportListRequest) => Promise<AdminSupportListResponse>;
  show: (opts: AdminSupportShowRequest) => Promise<AdminSupportShowResponse>;
  triage: (
    opts: AdminSupportTriageRequest,
  ) => Promise<AdminSupportTriageResponse>;
  search: (
    opts: AdminSupportSearchRequest,
  ) => Promise<AdminSupportSearchResponse>;
  getImage: (
    opts: AdminSupportGetImageRequest,
  ) => Promise<AdminSupportGetImageResponse>;
  getAttachment: (
    opts: AdminSupportGetAttachmentRequest,
  ) => Promise<AdminSupportGetAttachmentResponse>;
  planUpdate: (
    opts: AdminSupportUpdatePlanRequest,
  ) => Promise<AdminSupportUpdatePlanResponse>;
  update: (
    opts: AdminSupportUpdateRequest,
  ) => Promise<AdminSupportUpdateResponse>;
  planMerge: (
    opts: AdminSupportMergePlanRequest,
  ) => Promise<AdminSupportMergePlanResponse>;
  merge: (opts: AdminSupportMergeRequest) => Promise<AdminSupportMergeResponse>;
  planSpam: (
    opts: AdminSupportSpamPlanRequest,
  ) => Promise<AdminSupportSpamPlanResponse>;
  spam: (opts: AdminSupportSpamRequest) => Promise<AdminSupportSpamResponse>;
}
