import type { Configuration } from "@cocalc/conat/persist/storage";
import type { LroSummary } from "@cocalc/conat/hub/api/lro";
import type { ProjectTheme } from "@cocalc/util/db-schema/projects";

export interface AccountFeedAccountRow {
  account_id?: string | null;
  home_bay_id?: string | null;
  balance?: number | null;
  min_balance?: number | null;
  balance_alert?: boolean | null;
  auto_balance?: Record<string, any> | null;
  email_address?: string | null;
  email_address_verified?: Record<string, any> | null;
  email_address_problem?: Record<string, any> | null;
  editor_settings?: Record<string, any> | null;
  other_settings?: Record<string, any> | null;
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  terminal?: Record<string, any> | null;
  autosave?: number | null;
  evaluate_key?: string | null;
  font_size?: number | null;
  passports?: Record<string, any> | null;
  groups?: string[] | null;
  last_active?: Date | string | null;
  ssh_keys?: Record<string, any> | null;
  default_rootfs_image?: string | null;
  default_rootfs_image_gpu?: string | null;
  created?: Date | string | null;
  ephemeral?: number | null;
  customize?: Record<string, any> | null;
  unlisted?: boolean | null;
  tags?: string[] | null;
  tours?: string[] | null;
  purchase_closing_day?: number | null;
  email_daily_statements?: boolean | null;
  stripe_checkout_session?: Record<string, any> | null;
  stripe_usage_subscription?: string | null;
  stripe_customer?: Record<string, any> | null;
  unread_message_count?: number | null;
  profile?: Record<string, any> | null;
}

export interface AccountFeedProjectRow {
  project_id: string;
  title: string;
  description: string;
  name?: string | null;
  theme?: ProjectTheme | null;
  host_id: string | null;
  owning_bay_id: string;
  users: Record<string, any>;
  state: Record<string, any>;
  last_active: Record<string, any>;
  last_edited: string | null;
  last_backup?: string | null;
  deleted: boolean;
}

export interface AccountFeedCollaboratorRow {
  account_id: string;
  first_name: string | null;
  last_name: string | null;
  name: string | null;
  last_active: string | null;
  profile: Record<string, any> | null;
  common_project_count: number;
  updated_at: string | null;
}

export interface AccountFeedNotificationRow {
  notification_id: string;
  kind: string;
  project_id: string | null;
  summary: Record<string, any>;
  read_state: Record<string, any>;
  created_at: string | null;
  updated_at: string | null;
}

export interface AccountFeedNotificationKindCounts {
  total: number;
  unread: number;
  saved: number;
  archived: number;
}

export interface AccountFeedNotificationCounts {
  total: number;
  unread: number;
  saved: number;
  archived: number;
  by_kind: Record<string, AccountFeedNotificationKindCounts>;
}

export interface AccountFeedNotificationUpsertEvent {
  type: "notification.upsert";
  ts: number;
  account_id: string;
  notification: AccountFeedNotificationRow;
  reason:
    | "projected_upsert"
    | "read_state_updated"
    | "saved_state_updated"
    | "archived_state_updated";
}

export interface AccountFeedNotificationRemoveEvent {
  type: "notification.remove";
  ts: number;
  account_id: string;
  notification_id: string;
  reason:
    | "projected_upsert"
    | "read_state_updated"
    | "saved_state_updated"
    | "archived_state_updated";
}

export interface AccountFeedNotificationCountsEvent {
  type: "notification.counts";
  ts: number;
  account_id: string;
  counts: AccountFeedNotificationCounts;
  reason:
    | "projected_upsert"
    | "read_state_updated"
    | "saved_state_updated"
    | "archived_state_updated";
}

export interface AccountFeedAccountUpsertEvent {
  type: "account.upsert";
  ts: number;
  account_id: string;
  account: AccountFeedAccountRow;
  reason: "user_query_set" | "messages_unread_count_updated";
}

export interface AccountFeedProjectUpsertEvent {
  type: "project.upsert";
  ts: number;
  account_id: string;
  project: AccountFeedProjectRow;
}

export interface AccountFeedProjectRemoveEvent {
  type: "project.remove";
  ts: number;
  account_id: string;
  project_id: string;
  reason: "membership_removed";
}

export interface AccountFeedCollaboratorUpsertEvent {
  type: "collaborator.upsert";
  ts: number;
  account_id: string;
  collaborator: AccountFeedCollaboratorRow;
}

export interface AccountFeedCollaboratorRemoveEvent {
  type: "collaborator.remove";
  ts: number;
  account_id: string;
  collaborator_account_id: string;
  reason: "membership_removed";
}

export interface AccountFeedNewsRefreshEvent {
  type: "news.refresh";
  ts: number;
  account_id: string;
}

export interface AccountFeedProjectDetailInvalidateEvent {
  type: "project.detail.invalidate";
  ts: number;
  account_id: string;
  project_id: string;
  fields: string[];
}

export interface AccountFeedLroSummaryEvent {
  type: "lro.summary";
  ts: number;
  account_id: string;
  summary: LroSummary;
}

export type AccountFeedEvent =
  | AccountFeedAccountUpsertEvent
  | AccountFeedNotificationUpsertEvent
  | AccountFeedNotificationRemoveEvent
  | AccountFeedNotificationCountsEvent
  | AccountFeedProjectUpsertEvent
  | AccountFeedProjectRemoveEvent
  | AccountFeedCollaboratorUpsertEvent
  | AccountFeedCollaboratorRemoveEvent
  | AccountFeedNewsRefreshEvent
  | AccountFeedProjectDetailInvalidateEvent
  | AccountFeedLroSummaryEvent;

export function accountFeedStreamName(): string {
  return "account-feed";
}

export const ACCOUNT_FEED_STREAM_CONFIG: Partial<Configuration> = {
  max_msgs: 1000,
  max_age: 15 * 60 * 1000,
  max_bytes: 4 * 1024 * 1024,
};
