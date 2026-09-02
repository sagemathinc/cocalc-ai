/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type CodexNativeNotificationContent = Readonly<{
  title: string;
  body: string;
}>;

const ATTENTION_CONTENT: CodexNativeNotificationContent = Object.freeze({
  title: "Codex needs your attention",
  body: "Open CoCalc to view details.",
});

const COMPLETION_CONTENT: CodexNativeNotificationContent = Object.freeze({
  title: "Codex finished",
  body: "Open CoCalc to view details.",
});

// Native notifications may appear on a locked screen. Deliberately accept no
// model, project, path, or action content here.
export function codexNativeNotificationContent(
  attention: boolean,
): CodexNativeNotificationContent {
  return attention ? ATTENTION_CONTENT : COMPLETION_CONTENT;
}
