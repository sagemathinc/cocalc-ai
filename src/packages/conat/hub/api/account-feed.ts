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

export interface AccountFeedNotificationInvalidateEvent {
  type: "notification.invalidate";
  ts: number;
  account_id: string;
  reason:
    | "projected_upsert"
    | "read_state_updated"
    | "saved_state_updated"
    | "archived_state_updated";
  notification_ids?: string[];
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

export type AccountFeedEvent =
  | AccountFeedNotificationInvalidateEvent
  | AccountFeedProjectUpsertEvent
  | AccountFeedProjectRemoveEvent;

export function accountFeedStreamName(): string {
  return "account-feed";
}

export const ACCOUNT_FEED_STREAM_CONFIG: Partial<Configuration> = {
  max_msgs: 1000,
  max_age: 15 * 60 * 1000,
  max_bytes: 4 * 1024 * 1024,
};
