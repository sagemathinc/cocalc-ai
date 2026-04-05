import type { Configuration } from "@cocalc/conat/persist/storage";

export interface AccountFeedProjectRow {
  project_id: string;
  title: string;
  description: string;
  name?: string | null;
  avatar_image_tiny?: string | null;
  color?: string | null;
  host_id: string | null;
  owning_bay_id: string;
  users: Record<string, any>;
  state: Record<string, any>;
  last_active: Record<string, any>;
  last_edited: string | null;
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

export type AccountFeedEvent =
  | AccountFeedNotificationUpsertEvent
  | AccountFeedNotificationRemoveEvent
  | AccountFeedNotificationCountsEvent
  | AccountFeedProjectUpsertEvent
  | AccountFeedProjectRemoveEvent
  | AccountFeedCollaboratorUpsertEvent
  | AccountFeedCollaboratorRemoveEvent;

export function accountFeedStreamName(): string {
  return "account-feed";
}

export const ACCOUNT_FEED_STREAM_CONFIG: Partial<Configuration> = {
  max_msgs: 1000,
  max_age: 15 * 60 * 1000,
  max_bytes: 4 * 1024 * 1024,
};
