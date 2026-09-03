/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { DKV } from "@cocalc/conat/sync/dkv";
import type { NotificationListRow } from "@cocalc/conat/hub/api/notifications";
import { getLogger } from "@cocalc/conat/logger";
import { redux } from "@cocalc/frontend/app-framework";
import { ensureProjectReduxRuntime } from "@cocalc/frontend/app-framework/project-runtime";
import { getAntdNotificationInstance } from "@cocalc/frontend/app/antd-notification";
import { getSharedAccountDkv } from "@cocalc/frontend/conat/account-dkv";
import { store as customizeStore } from "@cocalc/frontend/customize";
import Fragment from "@cocalc/frontend/misc/fragment-id";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  OTHER_SETTINGS_NOTIFICATION_PREFERENCES_KEY,
  OTHER_SETTINGS_NOTIFICATION_PREFERENCES_V2_KEY,
  codexNotificationEventClass,
  normalizeNotificationPreferencesV2,
} from "@cocalc/util/notification-preferences";
import { isDirectlyWatchingCodexThread } from "@cocalc/frontend/chat/codex-watch-presence";
import {
  canShowCodexNativeNotification,
  codexNativeNotificationContent,
} from "./codex-native-content";

const TOAST_STATE_DKV_NAME = "notification-toast-state";
const CODEX_TURN_TOAST_PREFIX = "codex-turn.";
const logger = getLogger("frontend:notifications:codex-turn-toast");

const seenCodexTurnToastIds = new Set<string>();
const openCodexTurnToastIds = new Set<string>();
const seenCodexTurnStableSourceIds = new Set<string>();
let codexTurnToastState: DKV<number> | undefined;
let codexTurnToastStateInit: Promise<void> | undefined;
let codexTurnToastStateListener:
  | ((changeEvent: { key: string; value?: number }) => void)
  | undefined;
const deliveryTabId =
  `${webapp_client.browser_id ?? ""}`.trim() ||
  `tab-${Math.random().toString(36).slice(2)}`;
const deliveryCandidates = new Map<string, Set<string>>();
const nativeNotifications = new Map<string, Notification>();
const deliveryChannel =
  typeof BroadcastChannel === "undefined"
    ? undefined
    : new BroadcastChannel("cocalc-codex-notification-delivery");

deliveryChannel?.addEventListener("message", ({ data }) => {
  if (data?.type === "candidate" && typeof data.notificationId === "string") {
    const candidates =
      deliveryCandidates.get(data.notificationId) ?? new Set<string>();
    candidates.add(`${data.tabId}`);
    deliveryCandidates.set(data.notificationId, candidates);
  }
  if (data?.type === "delivered" && typeof data.notificationId === "string") {
    seenCodexTurnToastIds.add(data.notificationId);
  }
  if (data?.type === "resolved" && typeof data.notificationId === "string") {
    nativeNotifications.get(data.notificationId)?.close();
    nativeNotifications.delete(data.notificationId);
    getAntdNotificationInstance().destroy(
      `codex-attention:${data.notificationId}`,
    );
  }
});

function toastStateKey(notificationId: string): string {
  return `${CODEX_TURN_TOAST_PREFIX}${notificationId}`;
}

function getNotificationIdFromToastStateKey(key: string): string | undefined {
  if (!key.startsWith(CODEX_TURN_TOAST_PREFIX)) {
    return;
  }
  return key.slice(CODEX_TURN_TOAST_PREFIX.length);
}

function normalizeNotificationId(value: string | undefined | null): string {
  return `${value ?? ""}`.trim();
}

function documentVisible(): boolean {
  return (
    typeof document === "undefined" || document.visibilityState === "visible"
  );
}

function codexExternalDeliveryEnabled(channel: "toast" | "browser"): boolean {
  const key =
    channel === "toast"
      ? "codex_notification_toast_enabled"
      : "codex_notification_browser_enabled";
  return customizeStore.get(key) !== false;
}

function nativeCodexNotificationAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    "Notification" in window &&
    canShowCodexNativeNotification(window.Notification)
  );
}

async function claimCrossTabDelivery(notificationId: string): Promise<boolean> {
  if (!deliveryChannel) return true;
  const candidates = new Set<string>([deliveryTabId]);
  deliveryCandidates.set(notificationId, candidates);
  deliveryChannel.postMessage({
    type: "candidate",
    notificationId,
    tabId: deliveryTabId,
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 120));
  const winner = [
    ...(deliveryCandidates.get(notificationId) ?? candidates),
  ].sort()[0];
  deliveryCandidates.delete(notificationId);
  return winner === deliveryTabId && !seenCodexTurnToastIds.has(notificationId);
}

function codexDeliveryPolicy(row: Pick<NotificationListRow, "summary">) {
  const otherSettings = redux.getStore("account")?.get("other_settings");
  const rawV1 = otherSettings?.get?.(
    OTHER_SETTINGS_NOTIFICATION_PREFERENCES_KEY,
  );
  const rawV2 = otherSettings?.get?.(
    OTHER_SETTINGS_NOTIFICATION_PREFERENCES_V2_KEY,
  );
  const eventClass = codexNotificationEventClass({
    notice_type: row.summary?.notice_type,
    severity: row.summary?.severity,
  });
  if (!eventClass) return;
  return normalizeNotificationPreferencesV2(
    rawV2?.toJS?.() ?? rawV2,
    rawV1?.toJS?.() ?? rawV1,
  ).ai.events[eventClass];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function closeCodexTurnToastState(): void {
  if (
    codexTurnToastState != null &&
    codexTurnToastStateListener != null &&
    typeof codexTurnToastState.off === "function"
  ) {
    codexTurnToastState.off("change", codexTurnToastStateListener);
  }
  codexTurnToastState = undefined;
  codexTurnToastStateInit = undefined;
  codexTurnToastStateListener = undefined;
  seenCodexTurnToastIds.clear();
  openCodexTurnToastIds.clear();
  seenCodexTurnStableSourceIds.clear();
}

async function ensureCodexTurnToastState(account_id: string): Promise<void> {
  if (!account_id) {
    closeCodexTurnToastState();
    return;
  }
  if (codexTurnToastState != null && !codexTurnToastState.isClosed?.()) {
    return;
  }
  if (codexTurnToastStateInit != null) {
    await codexTurnToastStateInit;
    return;
  }
  codexTurnToastStateInit = (async () => {
    const dkv = await getSharedAccountDkv<number>({
      account_id,
      name: TOAST_STATE_DKV_NAME,
      merge: ({ local, remote }) => local ?? remote,
    });
    codexTurnToastState = dkv;
    seenCodexTurnToastIds.clear();
    for (const [key, value] of Object.entries(dkv.getAll())) {
      const notificationId = getNotificationIdFromToastStateKey(key);
      if (!notificationId || typeof value !== "number") {
        continue;
      }
      seenCodexTurnToastIds.add(notificationId);
    }
    codexTurnToastStateListener = (changeEvent) => {
      const notificationId = normalizeNotificationId(
        getNotificationIdFromToastStateKey(changeEvent.key),
      );
      if (!notificationId) {
        return;
      }
      if (typeof changeEvent.value === "number") {
        seenCodexTurnToastIds.add(notificationId);
      } else {
        seenCodexTurnToastIds.delete(notificationId);
      }
    };
    dkv.on("change", codexTurnToastStateListener);
  })();
  try {
    await codexTurnToastStateInit;
  } finally {
    codexTurnToastStateInit = undefined;
  }
}

async function markCodexTurnToastSeen(opts: {
  account_id: string;
  notificationId: string;
  seenAt: number;
}): Promise<void> {
  const notificationId = normalizeNotificationId(opts.notificationId);
  if (!notificationId) {
    return;
  }
  seenCodexTurnToastIds.add(notificationId);
  await ensureCodexTurnToastState(opts.account_id);
  if (codexTurnToastState == null) {
    return;
  }
  codexTurnToastState.set(toastStateKey(notificationId), opts.seenAt);
  await codexTurnToastState.save();
}

function codexTurnToastDescription(summary: Record<string, unknown>): string {
  const threadLabel = isNonEmptyString(summary.thread_label)
    ? summary.thread_label.trim()
    : "this chat";
  return summary.severity === "warning"
    ? `Codex ended with an error in ${threadLabel}.`
    : `Codex finished working in ${threadLabel}.`;
}

async function openCodexTurnNoticeTarget(
  row: Pick<NotificationListRow, "notification_id" | "project_id" | "summary">,
): Promise<void> {
  const project_id = isNonEmptyString(row.project_id)
    ? row.project_id
    : undefined;
  const path = isNonEmptyString(row.summary?.path)
    ? row.summary.path.trim()
    : undefined;
  if (project_id && path) {
    const fragmentId = Fragment.decode(
      isNonEmptyString(row.summary?.fragment_id)
        ? row.summary.fragment_id
        : undefined,
    );
    await ensureProjectReduxRuntime();
    await redux.getProjectActions(project_id)?.open_file({
      path,
      foreground: true,
      foreground_project: true,
      chat: !!fragmentId?.chat,
      fragmentId,
    });
    const attentionId = isNonEmptyString(row.summary?.attention_id)
      ? row.summary.attention_id
      : undefined;
    if (attentionId) {
      setTimeout(() => {
        const node = document.querySelector(
          `[data-codex-attention-id="${CSS.escape(attentionId)}"]`,
        ) as HTMLElement | null;
        node?.focus();
        node?.scrollIntoView({ block: "center" });
      }, 300);
    }
  }
  if (row.summary?.local_delivery !== true) {
    await webapp_client.conat_client.hub.notifications.markRead({
      notification_ids: [row.notification_id],
      read: true,
    });
  }
}

export function isCodexTurnCompletionNotification(
  row: Pick<NotificationListRow, "kind" | "summary">,
): boolean {
  return (
    row.kind === "account_notice" &&
    row.summary?.origin_label === "Codex" &&
    row.summary?.notice_type === "codex_turn_completion"
  );
}

export function isCodexAttentionNotification(
  row: Pick<NotificationListRow, "kind" | "summary">,
): boolean {
  return (
    row.kind === "account_notice" &&
    row.summary?.origin_label === "Codex" &&
    row.summary?.notice_type === "codex_attention"
  );
}

function isPendingCodexAttention(
  row: Pick<NotificationListRow, "kind" | "summary">,
): boolean {
  return (
    isCodexAttentionNotification(row) &&
    (row.summary?.attention_state ?? "pending") === "pending"
  );
}

function showNativeCodexNotification(opts: {
  notificationId: string;
  row: Pick<NotificationListRow, "notification_id" | "project_id" | "summary">;
  attention: boolean;
}): void {
  if (!nativeCodexNotificationAvailable()) {
    return;
  }
  const { title, body } = codexNativeNotificationContent(opts.attention);
  const notification = new window.Notification(title, {
    body,
    tag: `cocalc-codex:${opts.notificationId}`,
  });
  nativeNotifications.set(opts.notificationId, notification);
  notification.onclick = () => {
    window.focus();
    void openCodexTurnNoticeTarget(opts.row).catch((err) =>
      logger.warn("Unable to open Codex browser notification", err),
    );
    notification.close();
  };
  notification.onclose = () => nativeNotifications.delete(opts.notificationId);
}

export function showLocalCodexTurnCompletionToast(opts: {
  account_id: string;
  project_id: string;
  path: string;
  thread_id: string;
  thread_label?: string;
  newest_message_date?: string;
  stable_source_id?: string;
}): void {
  const stableSourceId = `${opts.stable_source_id ?? ""}`.trim();
  const threadLabel = `${opts.thread_label ?? ""}`.trim() || "this chat";
  const messageDate = Number(opts.newest_message_date ?? "");
  const fallbackId = `${opts.project_id}:${opts.path}:${opts.newest_message_date ?? ""}`;
  void showCodexTurnCompletionToastBestEffort({
    account_id: opts.account_id,
    row: {
      notification_id: stableSourceId || fallbackId,
      kind: "account_notice",
      project_id: opts.project_id,
      summary: {
        origin_label: "Codex",
        notice_type: "codex_turn_completion",
        title: "Codex turn finished",
        path: opts.path,
        thread_id: opts.thread_id,
        thread_label: threadLabel,
        stable_source_id: stableSourceId || undefined,
        local_delivery: true,
        fragment_id: Number.isFinite(messageDate)
          ? `chat=${Math.floor(messageDate)}`
          : undefined,
      },
    },
  }).catch((err) => logger.warn("Unable to deliver Codex notification", err));
}

export async function showCodexTurnCompletionToastBestEffort(opts: {
  account_id: string;
  row: Pick<
    NotificationListRow,
    "notification_id" | "kind" | "project_id" | "summary"
  >;
}): Promise<void> {
  const attention = isCodexAttentionNotification(opts.row);
  const completion = isCodexTurnCompletionNotification(opts.row);
  if (!attention && !completion) {
    return;
  }
  const notificationId = normalizeNotificationId(opts.row.notification_id);
  if (!notificationId) {
    return;
  }
  const stableSourceId = `${opts.row.summary?.stable_source_id ?? ""}`.trim();
  const deliveryId = stableSourceId || notificationId;
  if (attention && !isPendingCodexAttention(opts.row)) {
    nativeNotifications.get(deliveryId)?.close();
    nativeNotifications.delete(deliveryId);
    getAntdNotificationInstance().destroy(`codex-attention:${deliveryId}`);
    deliveryChannel?.postMessage({
      type: "resolved",
      notificationId: deliveryId,
    });
    return;
  }
  const policy = codexDeliveryPolicy(opts.row);
  if (!policy) return;
  const directlyWatching = isDirectlyWatchingCodexThread({
    account_id: opts.account_id,
    project_id: `${opts.row.project_id ?? ""}`,
    path: `${opts.row.summary?.path ?? ""}`,
    thread_id: `${opts.row.summary?.thread_id ?? ""}`,
  });
  if (directlyWatching) {
    if (opts.row.summary?.local_delivery !== true) {
      await webapp_client.conat_client.hub.notifications.markRead({
        notification_ids: [notificationId],
        read: true,
      });
    }
    return;
  }
  const visible = documentVisible();
  const eligible = visible
    ? policy.toast && codexExternalDeliveryEnabled("toast")
    : policy.browser &&
      codexExternalDeliveryEnabled("browser") &&
      nativeCodexNotificationAvailable();
  if (!eligible) return;
  await ensureCodexTurnToastState(opts.account_id);
  if (
    (stableSourceId && seenCodexTurnStableSourceIds.has(stableSourceId)) ||
    seenCodexTurnToastIds.has(deliveryId) ||
    openCodexTurnToastIds.has(deliveryId)
  ) {
    return;
  }
  if (!(await claimCrossTabDelivery(deliveryId))) return;
  if (stableSourceId) seenCodexTurnStableSourceIds.add(stableSourceId);
  openCodexTurnToastIds.add(deliveryId);
  try {
    await markCodexTurnToastSeen({
      account_id: opts.account_id,
      notificationId: deliveryId,
      seenAt: Date.now(),
    });
  } catch (err) {
    logger.warn("failed to persist codex turn toast state", err);
  }
  deliveryChannel?.postMessage({
    type: "delivered",
    notificationId: deliveryId,
  });
  if (!visible) {
    showNativeCodexNotification({
      notificationId: deliveryId,
      row: opts.row,
      attention,
    });
    return;
  }
  const notification = getAntdNotificationInstance();
  const title = attention
    ? "Codex needs your attention"
    : isNonEmptyString(opts.row.summary?.title)
      ? opts.row.summary.title.trim()
      : "Codex turn finished";
  notification[attention ? "warning" : "info"]({
    key: attention
      ? `codex-attention:${deliveryId}`
      : `codex-turn:${deliveryId}`,
    title,
    description: attention
      ? "Open the Codex thread to respond."
      : codexTurnToastDescription(opts.row.summary ?? {}),
    duration: attention ? 0 : 6,
    onClick: () => {
      void openCodexTurnNoticeTarget(opts.row).catch((err) => {
        logger.warn("failed to open codex turn notification target", err);
      });
    },
    onClose: () => {
      openCodexTurnToastIds.delete(deliveryId);
    },
  });
}

export const showCodexNotificationBestEffort =
  showCodexTurnCompletionToastBestEffort;

webapp_client.on?.("signed_out", closeCodexTurnToastState);
webapp_client.on?.("remember_me_failed", closeCodexTurnToastState);
