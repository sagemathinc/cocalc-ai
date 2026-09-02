import { authFirstRequireAccount, declareHubApiPrincipalPolicy } from "./util";
import type { Configuration } from "@cocalc/conat/persist/storage";

export type NotificationPriority = "low" | "normal" | "high";
export type NotificationSeverity = "info" | "warning" | "error";
export type NotificationInboxState = "all" | "unread" | "saved" | "archived";
export type MentionNotificationReason = "mention" | "thread_follow";

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
  notification_reason?: MentionNotificationReason;
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
  host_id?: string;
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

export interface CreateCodexAttentionNoticeOptions {
  account_id?: string;
  host_id?: string;
  source_project_id: string;
  source_path: string;
  source_fragment_id?: string;
  thread_id: string;
  thread_label?: string;
  attention_id: string;
  attention_kind: string;
  is_blocking: boolean;
  title: string;
  stable_source_id: string;
  acknowledged_at?: number;
  snoozed_until?: number;
  state?:
    | "pending"
    | "answered"
    | "declined"
    | "canceled"
    | "resolved"
    | "expired"
    | "superseded"
    | "stale";
}

export interface GetCodexFreshAuthActionStatusOptions {
  account_id?: string;
  host_id?: string;
  source_project_id: string;
  challenge_id: string;
}

export interface CodexFreshAuthAttentionContext {
  project_id: string;
  path: string;
  thread_id: string;
  turn_id?: string;
  message_date?: string;
  purpose?: string;
}

export interface StartCodexFreshAuthActionOptions {
  account_id?: string;
  source_project_id: string;
  browser_id: string;
  duration?: "default" | "extended";
  context: CodexFreshAuthAttentionContext;
}

export interface CodexFreshAuthActionStart {
  challenge_id: string;
  state: "pending";
  expires_at: string;
}

export interface CodexFreshAuthActionStatus {
  challenge_id: string;
  state: "pending" | "approved" | "canceled" | "expired";
  expires_at: string;
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

export interface NotificationListSnapshot {
  rows: NotificationListRow[];
  read_through_revision: string;
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

export interface MarkAllNotificationsReadOptions {
  account_id?: string;
  project_id: string | null;
  read_through_revision: string;
}

export interface MarkAllNotificationsReadResult {
  updated_count: number;
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
  createCodexAttentionNotice: (
    opts: CreateCodexAttentionNoticeOptions,
  ) => Promise<CreateNotificationResult>;
  startCodexFreshAuthAction: (
    opts: StartCodexFreshAuthActionOptions,
  ) => Promise<CodexFreshAuthActionStart>;
  getCodexFreshAuthActionStatus: (
    opts: GetCodexFreshAuthActionStatusOptions,
  ) => Promise<CodexFreshAuthActionStatus>;
  list: (opts?: ListNotificationsOptions) => Promise<NotificationListRow[]>;
  listSnapshot: (
    opts?: ListNotificationsOptions,
  ) => Promise<NotificationListSnapshot>;
  counts: (opts?: { account_id?: string }) => Promise<NotificationCountsResult>;
  markRead: (
    opts: MarkNotificationReadOptions,
  ) => Promise<MarkNotificationReadResult>;
  markAllRead: (
    opts: MarkAllNotificationsReadOptions,
  ) => Promise<MarkAllNotificationsReadResult>;
  save: (opts: SaveNotificationOptions) => Promise<MarkNotificationReadResult>;
  archive: (
    opts: ArchiveNotificationOptions,
  ) => Promise<MarkNotificationReadResult>;
}

export const notifications = {
  createMention: authFirstRequireAccount,
  createAccountNotice: authFirstRequireAccount,
  createCodexTurnNotice: declareHubApiPrincipalPolicy(
    "account-or-project-or-host",
    async ({ args, account_id, project_id, host_id, auth_actor }) => {
      if (auth_actor === "agent") {
        throw Error("managed compute agents cannot create Codex turn notices");
      }
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
        // The account_id is the notification target here, not the actor. Bind
        // the source project separately so a project cannot impersonate a
        // different project's Codex activity.
        args[0].source_project_id = project_id;
        return args;
      }
      if (host_id) {
        if (!args[0].account_id) {
          throw Error(
            "host-authenticated codex turn notices require an account_id target",
          );
        }
        args[0].host_id = host_id;
        return args;
      }
      throw Error("must be signed in as an account, project, or host");
    },
    { preservesAccountTarget: true },
  ),
  createCodexAttentionNotice: declareHubApiPrincipalPolicy(
    "account-or-host",
    async ({ args, account_id, host_id, auth_actor }) => {
      if (auth_actor === "agent") {
        throw Error("managed compute agents cannot create Codex notices");
      }
      args[0] ??= {} as any;
      if (account_id) {
        args[0].account_id = account_id;
        return args;
      }
      if (host_id) {
        if (!args[0].account_id) {
          throw Error("host-authenticated Codex notices require a target");
        }
        args[0].host_id = host_id;
        return args;
      }
      throw Error("must be signed in as an account or host");
    },
    { preservesAccountTarget: true },
  ),
  startCodexFreshAuthAction: declareHubApiPrincipalPolicy(
    "account-or-compute-agent",
    async ({
      args,
      account_id,
      project_id,
      auth_actor,
      auth_token_fingerprint,
      auth_iat_s,
      auth_exp_s,
    }) => {
      args[0] ??= {} as any;
      delete args[0].host_id;
      delete args[0].agent_auth;
      if (auth_actor === "agent") {
        if (
          !account_id ||
          !project_id ||
          !auth_token_fingerprint ||
          !auth_iat_s ||
          !auth_exp_s
        ) {
          throw new Error("invalid managed-compute agent identity");
        }
        args[0].account_id = account_id;
        args[0].source_project_id = project_id;
        return args;
      }
      if (!account_id) throw new Error("user must be signed in");
      args[0].account_id = account_id;
      return args;
    },
    { preservesAccountTarget: true },
  ),
  getCodexFreshAuthActionStatus: declareHubApiPrincipalPolicy(
    "account-or-host-or-compute-agent",
    async ({
      args,
      account_id,
      project_id,
      host_id,
      auth_actor,
      auth_token_fingerprint,
      auth_iat_s,
      auth_exp_s,
    }) => {
      args[0] ??= {} as any;
      delete args[0].host_id;
      delete args[0].agent_auth;
      if (auth_actor === "agent") {
        if (
          !account_id ||
          !project_id ||
          !auth_token_fingerprint ||
          !auth_iat_s ||
          !auth_exp_s
        ) {
          throw new Error("invalid managed-compute agent identity");
        }
        args[0].account_id = account_id;
        args[0].source_project_id = project_id;
        return args;
      }
      if (host_id) {
        if (!args[0].account_id || !args[0].source_project_id) {
          throw new Error(
            "host-authenticated Codex fresh-auth status requires an account and source project",
          );
        }
        args[0].host_id = host_id;
        return args;
      }
      if (!account_id) throw new Error("user must be signed in");
      args[0].account_id = account_id;
      return args;
    },
    { preservesAccountTarget: true },
  ),
  list: authFirstRequireAccount,
  listSnapshot: authFirstRequireAccount,
  counts: authFirstRequireAccount,
  markRead: authFirstRequireAccount,
  markAllRead: authFirstRequireAccount,
  save: authFirstRequireAccount,
  archive: authFirstRequireAccount,
};
