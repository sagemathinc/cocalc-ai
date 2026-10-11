/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Lightweight accessors for ChatMessage objects (plain/Immer).

import type { ChatMessage, MessageHistory } from "./types";

export function field<T = any>(
  obj: ChatMessage | undefined,
  key: string,
): T | undefined {
  if (obj == null) return undefined;
  return (obj as any)[key] as T;
}

export function historyArray(
  msg: Partial<ChatMessage> | undefined,
): MessageHistory[] {
  if (!msg) return [];
  const h = msg.history;
  return Array.isArray(h) ? h : [];
}

export function firstHistory(
  msg: ChatMessage | undefined,
): MessageHistory | undefined {
  const h = historyArray(msg);
  return h.length > 0 ? h[0] : undefined;
}

export function dateValue(msg: ChatMessage | undefined): Date | undefined {
  if (!msg) return undefined;
  const d = msg.date;
  if (d instanceof Date) return d;
  if (typeof d === "string" || typeof d === "number") {
    const dt = new Date(d);
    return isNaN(dt.valueOf()) ? undefined : dt;
  }
  return undefined;
}

export function senderId(msg: ChatMessage | undefined): string | undefined {
  return msg?.sender_id;
}

export function parentMessageId(
  msg: ChatMessage | undefined,
): string | undefined {
  const parent = (msg as any)?.parent_message_id;
  if (typeof parent === "string" && parent.trim().length > 0) {
    return parent.trim();
  }
  return undefined;
}

export function isAcpAssistantMessage(msg: ChatMessage | undefined): boolean {
  if (!msg) return false;
  for (const key of [
    "acp_account_id",
    "acp_thread_id",
    "acp_log_store",
    "acp_log_key",
    "acp_log_subject",
    "acp_live_log_stream",
    "acp_live_preview_stream",
  ]) {
    const value = field<unknown>(msg, key);
    if (typeof value === "string" && value.trim().length > 0) return true;
  }
  const startedAt = Number(field<number | string>(msg, "acp_started_at_ms"));
  return Number.isFinite(startedAt) && startedAt > 0;
}

// Legacy: replies of the retired scheduled thread automations ran in their
// own sessions, so a thread never resumes from them.
export function isAcpAutomationMessage(msg: ChatMessage | undefined): boolean {
  const automationId = field<string>(msg, "acp_automation_id");
  return typeof automationId === "string" && automationId.trim().length > 0;
}

// Return list of account IDs currently editing the message.
export function editingArray(msg: ChatMessage | undefined): string[] {
  const editing = msg?.editing;
  return Array.isArray(editing) ? editing : [];
}
