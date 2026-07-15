/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { EmailLane } from "./notification-email";
import {
  getNotificationCategoryDefinition,
  normalizeNotificationPreferences,
  type NotificationCategory,
  type NotificationEmailMode,
} from "./notification-preferences";

export interface ResolveNotificationDeliveryPolicyOptions {
  kind: string;
  origin_kind?: string | null;
  actor_account_id?: string | null;
  target_account_id: string;
  summary?: Record<string, any> | null;
  event_payload?: Record<string, any> | null;
  preferences?: unknown;
}

export interface NotificationDeliveryPolicy {
  category: NotificationCategory;
  lane: EmailLane;
  delivery_mode: NotificationEmailMode;
  required: boolean;
  responsible_account_id: string | null;
}

function text(value: unknown): string {
  return `${value ?? ""}`.trim();
}

function lower(value: unknown): string {
  return text(value).toLowerCase();
}

function accountNoticeCategory(opts: {
  summary: Record<string, any>;
  event_payload: Record<string, any>;
  origin_kind?: string | null;
}): NotificationCategory {
  const noticeType = lower(
    opts.summary.notice_type ?? opts.event_payload.notice_type,
  );
  if (noticeType === "codex_turn_completion") {
    return "ai";
  }
  if (noticeType.startsWith("billing_") || noticeType.includes("spend")) {
    return "billing";
  }
  if (noticeType.startsWith("security_")) {
    return "security";
  }
  if (noticeType.startsWith("maintenance_")) {
    return "maintenance";
  }
  if (noticeType.startsWith("course_")) {
    return "course";
  }
  if (noticeType.startsWith("project_access_")) {
    return "access_requests";
  }

  const originLabel = lower(
    opts.summary.origin_label ?? opts.event_payload.origin_label,
  );
  const title = lower(opts.summary.title ?? opts.event_payload.title);
  if (
    originLabel.includes("codex") ||
    title.includes("codex") ||
    title.includes("ai ")
  ) {
    return "ai";
  }
  if (
    originLabel.includes("billing") ||
    title.includes("billing") ||
    title.includes("payment") ||
    title.includes("spend limit") ||
    title.includes("dedicated host")
  ) {
    return "billing";
  }
  if (originLabel.includes("project access")) {
    return "access_requests";
  }
  if (originLabel.includes("site licenses")) {
    return "membership_requests";
  }
  if (originLabel.includes("support") || opts.origin_kind === "admin") {
    return "support";
  }
  return "support";
}

function mentionCategory(opts: {
  summary: Record<string, any>;
  event_payload: Record<string, any>;
}): NotificationCategory {
  const reason = lower(
    opts.summary.notification_reason ?? opts.event_payload.notification_reason,
  );
  return reason === "thread_follow" ? "chat_replies" : "mentions";
}

function laneForCategory(category: NotificationCategory): EmailLane {
  switch (category) {
    case "billing":
    case "security":
      return "critical";
    case "support":
    case "maintenance":
    case "membership_requests":
    case "access_requests":
      return "transactional";
    case "product":
      return "marketing";
    case "mentions":
    case "chat_replies":
    case "ai":
    case "course":
      return "notification";
  }
}

function responsibleAccountId(opts: {
  category: NotificationCategory;
  lane: EmailLane;
  actor_account_id?: string | null;
  target_account_id: string;
}): string | null {
  if (opts.category === "billing" || opts.category === "security") {
    return null;
  }
  if (opts.lane === "marketing" || opts.lane === "transactional") {
    return null;
  }
  const actor = text(opts.actor_account_id);
  return actor || opts.target_account_id;
}

export function resolveNotificationDeliveryPolicy(
  opts: ResolveNotificationDeliveryPolicyOptions,
): NotificationDeliveryPolicy {
  const kind = text(opts.kind);
  const summary = opts.summary ?? {};
  const event_payload = opts.event_payload ?? {};
  const category: NotificationCategory =
    kind === "mention"
      ? mentionCategory({ summary, event_payload })
      : kind === "account_notice"
        ? accountNoticeCategory({
            summary,
            event_payload,
            origin_kind: opts.origin_kind,
          })
        : "support";
  const definition = getNotificationCategoryDefinition(category);
  const preferences = normalizeNotificationPreferences(opts.preferences);
  const required = definition.requiredEmailMode != null;
  const delivery_mode = required
    ? definition.requiredEmailMode!
    : preferences.email[category];
  const lane = laneForCategory(category);
  return {
    category,
    lane,
    delivery_mode,
    required,
    responsible_account_id: responsibleAccountId({
      category,
      lane,
      actor_account_id: opts.actor_account_id,
      target_account_id: opts.target_account_id,
    }),
  };
}
