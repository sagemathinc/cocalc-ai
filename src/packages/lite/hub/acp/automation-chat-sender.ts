/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const DEFAULT_AUTOMATION_CHAT_SENDER_ID = "openai-codex-agent";

export function resolveAutomationChatSenderId(
  agentModel?: string | null,
): string {
  const normalized = `${agentModel ?? ""}`.trim();
  return normalized || DEFAULT_AUTOMATION_CHAT_SENDER_ID;
}
