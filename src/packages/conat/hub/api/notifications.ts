import { authFirstRequireAccount } from "./util";

export type NotificationPriority = "low" | "normal" | "high";
export type NotificationSeverity = "info" | "warning" | "error";

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
}

export interface Notifications {
  createMention: (
    opts: CreateMentionNotificationOptions,
  ) => Promise<CreateNotificationResult>;
  createAccountNotice: (
    opts: CreateAccountNoticeOptions,
  ) => Promise<CreateNotificationResult>;
}

export const notifications = {
  createMention: authFirstRequireAccount,
  createAccountNotice: authFirstRequireAccount,
};
