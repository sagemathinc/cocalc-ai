/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type CodexNativeNotificationContent = Readonly<{
  title: string;
  body: string;
}>;

const ATTENTION_CONTENT: CodexNativeNotificationContent = Object.freeze({
  title: "Agent needs your attention",
  body: "Open CoCalc to view details.",
});

const COMPLETION_CONTENT: CodexNativeNotificationContent = Object.freeze({
  title: "Agent turn finished",
  body: "Open CoCalc to view details.",
});

const PAUSED_CONTENT: CodexNativeNotificationContent = Object.freeze({
  title: "Agent turn paused",
  body: "It resumes automatically. Open CoCalc to view details.",
});

// Native notifications may appear on a locked screen. Deliberately accept no
// model, project, path, or action content here.
export function codexNativeNotificationContent(
  attention: boolean,
  paused = false,
): CodexNativeNotificationContent {
  return attention
    ? ATTENTION_CONTENT
    : paused
      ? PAUSED_CONTENT
      : COMPLETION_CONTENT;
}

export function canShowCodexNativeNotification(
  notificationApi: Pick<typeof Notification, "permission"> | undefined,
): boolean {
  return notificationApi?.permission === "granted";
}
