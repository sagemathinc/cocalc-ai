/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { DKV } from "@cocalc/conat/sync/dkv";
import type { NotificationListRow } from "@cocalc/conat/hub/api/notifications";
import { redux } from "@cocalc/frontend/app-framework";
import { getAntdNotificationInstance } from "@cocalc/frontend/app/antd-notification";
import { getSharedAccountDkv } from "@cocalc/frontend/conat/account-dkv";
import Fragment from "@cocalc/frontend/misc/fragment-id";
import { webapp_client } from "@cocalc/frontend/webapp-client";

const TOAST_STATE_DKV_NAME = "notification-toast-state";
const CODEX_TURN_TOAST_PREFIX = "codex-turn.";

const seenCodexTurnToastIds = new Set<string>();
const openCodexTurnToastIds = new Set<string>();
let codexTurnToastState: DKV<number> | undefined;
let codexTurnToastStateInit: Promise<void> | undefined;
let codexTurnToastStateListener:
  | ((changeEvent: { key: string; value?: number }) => void)
  | undefined;

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
    await redux.getProjectActions(project_id)?.open_file({
      path,
      foreground: true,
      foreground_project: true,
      chat: !!fragmentId?.chat,
      fragmentId,
    });
  }
  await webapp_client.conat_client.hub.notifications.markRead({
    notification_ids: [row.notification_id],
    read: true,
  });
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

export async function showCodexTurnCompletionToastBestEffort(opts: {
  account_id: string;
  row: Pick<
    NotificationListRow,
    "notification_id" | "kind" | "project_id" | "summary"
  >;
}): Promise<void> {
  if (!documentVisible() || !isCodexTurnCompletionNotification(opts.row)) {
    return;
  }
  const notificationId = normalizeNotificationId(opts.row.notification_id);
  if (!notificationId) {
    return;
  }
  await ensureCodexTurnToastState(opts.account_id);
  if (
    seenCodexTurnToastIds.has(notificationId) ||
    openCodexTurnToastIds.has(notificationId)
  ) {
    return;
  }
  openCodexTurnToastIds.add(notificationId);
  try {
    await markCodexTurnToastSeen({
      account_id: opts.account_id,
      notificationId,
      seenAt: Date.now(),
    });
  } catch (err) {
    console.warn("failed to persist codex turn toast state", err);
  }
  const notification = getAntdNotificationInstance();
  const title = isNonEmptyString(opts.row.summary?.title)
    ? opts.row.summary.title.trim()
    : "Codex turn finished";
  notification.info({
    key: `codex-turn:${notificationId}`,
    title,
    description: codexTurnToastDescription(opts.row.summary ?? {}),
    duration: 6,
    onClick: () => {
      void openCodexTurnNoticeTarget(opts.row).catch((err) => {
        console.warn("failed to open codex turn notification target", err);
      });
    },
    onClose: () => {
      openCodexTurnToastIds.delete(notificationId);
    },
  });
}

webapp_client.on?.("signed_out", closeCodexTurnToastState);
webapp_client.on?.("remember_me_failed", closeCodexTurnToastState);
