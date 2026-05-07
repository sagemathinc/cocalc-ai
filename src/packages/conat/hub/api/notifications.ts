import { authFirstRequireAccount } from "./util";
import type { Configuration } from "@cocalc/conat/persist/storage";

export type NotificationPriority = "low" | "normal" | "high";
export type NotificationSeverity = "info" | "warning" | "error";
export type NotificationInboxState = "all" | "unread" | "saved" | "archived";

export interface CreateMentionNotificationOptions {
  account_id?: string;
  source_project_id: string;
  source_path: string;
  source_fragment_id?: string;
  actor_account_id?: string;
  target_account_ids: string[];
  description: string;
  priority?: NotificationPriority;
  stable_source_id?: string;
}

export interface CreatedNotificationTargetInfo {
  target_account_id: string;
  target_home_bay_id: string;
  notification_id: string;
}

export interface CreateNotificationResult {
  event_id: string;
  kind: "mention" | "account_notice";
  source_bay_id: string;
  target_count: number;
  notification_ids: string[];
  targets: CreatedNotificationTargetInfo[];
}

export interface CreateAccountNoticeOptions {
  account_id?: string;
  target_account_ids: string[];
  severity: NotificationSeverity;
  title: string;
  body_markdown: string;
  origin_label?: string;
  action_link?: string;
  action_label?: string;
  dedupe_key?: string;
  source_project_id?: string | null;
  source_path?: string;
  source_fragment_id?: string;
}

export interface CreateCodexTurnNoticeOptions {
  account_id?: string;
  source_project_id: string;
  source_path: string;
  source_fragment_id?: string;
  thread_id: string;
  thread_label?: string;
  title: string;
  body_markdown: string;
  severity?: NotificationSeverity;
  stable_source_id?: string;
}

export interface NotificationListRow {
  notification_id: string;
  kind: string;
  project_id: string | null;
  summary: Record<string, any>;
  read_state: Record<string, any>;
  created_at: Date | null;
  updated_at: Date | null;
}

export interface ListNotificationsOptions {
  account_id?: string;
  limit?: number;
  notification_id?: string;
  kind?: string;
  project_id?: string | null;
  state?: NotificationInboxState;
}

export interface NotificationCountsResult {
  total: number;
  unread: number;
  saved: number;
  archived: number;
  by_kind: Record<
    string,
    {
      total: number;
      unread: number;
      saved: number;
      archived: number;
    }
  >;
}

export interface NotificationFeedEvent {
  type: "invalidate";
  ts: number;
  account_id: string;
  reason:
    | "projected_upsert"
    | "read_state_updated"
    | "saved_state_updated"
    | "archived_state_updated";
  notification_ids?: string[];
}

export function notificationFeedStreamName(): string {
  return "notifications-realtime";
}

export const NOTIFICATION_FEED_STREAM_CONFIG: Partial<Configuration> = {
  max_msgs: 500,
  max_age: 15 * 60 * 1000,
  max_bytes: 2 * 1024 * 1024,
};

export interface MarkNotificationReadOptions {
  account_id?: string;
  notification_ids: string[];
  read?: boolean;
}

export interface MarkNotificationReadResult {
  updated_count: number;
  notification_ids?: string[];
}

export interface SaveNotificationOptions {
  account_id?: string;
  notification_ids: string[];
  saved?: boolean;
}

export interface ArchiveNotificationOptions {
  account_id?: string;
  notification_ids: string[];
  archived?: boolean;
}

export interface Notifications {
  createMention: (
    opts: CreateMentionNotificationOptions,
  ) => Promise<CreateNotificationResult>;
  createAccountNotice: (
    opts: CreateAccountNoticeOptions,
  ) => Promise<CreateNotificationResult>;
  createCodexTurnNotice: (
    opts: CreateCodexTurnNoticeOptions,
  ) => Promise<CreateNotificationResult>;
  list: (opts?: ListNotificationsOptions) => Promise<NotificationListRow[]>;
  counts: (opts?: { account_id?: string }) => Promise<NotificationCountsResult>;
  markRead: (
    opts: MarkNotificationReadOptions,
  ) => Promise<MarkNotificationReadResult>;
  save: (opts: SaveNotificationOptions) => Promise<MarkNotificationReadResult>;
  archive: (
    opts: ArchiveNotificationOptions,
  ) => Promise<MarkNotificationReadResult>;
}

export const notifications = {
  createMention: authFirstRequireAccount,
  createAccountNotice: authFirstRequireAccount,
  createCodexTurnNotice: async ({ args, account_id, project_id }) => {
    if (args[0] == null) {
      args[0] = {} as any;
    }
    if (account_id) {
      args[0].account_id = account_id;
      return args;
    }
    if (project_id) {
      if (!args[0].account_id) {
        throw Error(
          "project-authenticated codex turn notices require an account_id target",
        );
      }
      return args;
    }
    throw Error("must be signed in as an account or project");
  },
  list: authFirstRequireAccount,
  counts: authFirstRequireAccount,
  markRead: authFirstRequireAccount,
  save: authFirstRequireAccount,
  archive: authFirstRequireAccount,
};
