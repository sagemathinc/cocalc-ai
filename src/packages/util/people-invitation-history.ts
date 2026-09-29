/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { ProjectViewerReadPolicy } from "./project-access";
import type {
  PeopleInvitationTarget,
  PeopleInvitationDeliveryReceipt,
} from "./people-invitations";

/** Private, owner-scoped identity. Never substitute person_id for account_id. */
export interface PeopleContact {
  person_id: string;
  account_id: string;
  display_label: string | null;
  /** Protected at rest; returned only to this contact's owner. */
  email: string | null;
  linked_account_id: string | null;
  link_provenance: "explicit_account" | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
}
export type PeopleAccessInvitationStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "blocked"
  | "expired"
  | "canceled";
interface PeopleInvitationHistoryBase {
  invitation_id: string;
  project_id: string;
  sender_account_id: string;
  recipient_account_id: string | null;
  /** Owner-private contact identity, populated only in sender views. */
  person_id: string | null;
  /** Sender-private contact label/email; never present in recipient projection. */
  recipient_label?: string;
  /** Permitted public account name, never email-lookup enrichment. */
  sender_label?: string;
  message: string | null;
  created_at: string;
  updated_at: string;
  source_version: string;
  source_bay_id: string;
}
export interface PeopleAccessInvitation extends PeopleInvitationHistoryBase {
  kind: "access";
  accepted_account_id: string | null;
  status: PeopleAccessInvitationStatus;
  role: "collaborator" | "viewer";
  read_policy: ProjectViewerReadPolicy | null;
  invite_source: string;
  scope: string | null;
  expires_at: string | null;
  responded_at: string | null;
  last_sent_at: string | null;
  resend_count: number;
}
export interface PeopleCollaborationInvitationHistoryRow extends PeopleInvitationHistoryBase {
  kind: "collaboration";
  status: "active" | "withdrawn";
  target?: PeopleInvitationTarget;
  access_invite_ids: string[];
  delivery: PeopleInvitationDeliveryReceipt[];
  notification_id: string | null;
  notification_read: boolean | null;
  notification_archived: boolean | null;
  /** Recipient state is independent of sender delivery and access acceptance. */
  read_at: string | null;
  dismissed_at: string | null;
}
export type PeopleInvitationHistoryRow =
  | PeopleAccessInvitation
  | PeopleCollaborationInvitationHistoryRow;
export interface PeopleInvitationHistoryQuery {
  account_id: string;
  /** Selected row plus its linked access rows and consolidated-notice group,
   * always intersected with this account's authorized projection namespace. */
  invitation_id?: string;
  view?: "sent" | "received" | "history";
  person_id?: string;
  participant_account_id?: string;
  /** Authored message/target label only, at most 200 characters. */
  search?: string;
  /** At most 25. Empty means no project filter. */
  project_ids?: string[];
  kind?: "access" | "collaboration";
  status?: PeopleInvitationHistoryRow["status"];
  after?: string;
  limit?: number;
}
export interface PeopleInvitationCounts {
  /** Global uncapped counts, independent of selected page/filters. */
  pending: { sent: number; received: number };
  /** null means not measured; never use pending access offers as unread. */
  unread: number | null;
  revision: string;
  coverage: "partial" | "complete";
  /** Explanation of incomplete coverage, not a claim that a worker is running. */
  coverage_message?: string;
}
export interface PeopleInvitationHistoryPage extends PeopleInvitationCounts {
  items: PeopleInvitationHistoryRow[];
  total: number;
  next?: string;
}
export interface PeopleContactQuery {
  account_id: string;
  limit?: number;
  cursor?: string;
  include_archived?: boolean;
  /** Server-side anti-join, not dedup against a loaded collaborator page. */
  without_shared_projects?: boolean;
  search?: string;
}
export interface PeopleContactPage {
  items: PeopleContact[];
  total: number;
  next_cursor?: string;
  revision: string;
}
export interface EnsurePeopleContact {
  account_id: string;
  recipient: { account_id: string } | { email: string };
  display_label?: string;
}

export type PeopleInvitationQuery = PeopleInvitationHistoryQuery;
export type PeopleInvitationPage = PeopleInvitationHistoryPage;
