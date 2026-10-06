/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import callHub from "@cocalc/conat/hub/call-hub";
import type { CodexThreadConfig } from "@cocalc/chat";
import type {
  CreateCodexTurnNoticeOptions,
  NotificationSeverity,
} from "@cocalc/conat/hub/api/notifications";
import type { Client as ConatClient } from "@cocalc/conat/core/client";

export type CodexTurnTerminalState = "complete" | "error";
const CODEX_TURN_NOTICE_TIMEOUT_MS = 20_000;

function normalizeThreadLabel(value?: string | null): string {
  const label = `${value ?? ""}`.trim();
  return label || "this chat";
}

function normalizeErrorText(value?: string | null): string | undefined {
  const text = `${value ?? ""}`.trim();
  if (!text) return;
  return text.length > 600 ? `${text.slice(0, 597)}...` : text;
}

export function shouldNotifyOnCodexTurnFinish(
  config?: CodexThreadConfig | null,
): boolean {
  return codexTurnNotifyPreference(config) === true;
}

export function codexTurnNotifyPreference(
  config?: CodexThreadConfig | { get: (key: string) => unknown } | null,
): boolean | undefined {
  const getter = (config as { get?: (key: string) => unknown } | null)?.get;
  const value =
    typeof getter === "function"
      ? getter.call(config, "notifyOnTurnFinish")
      : (config as CodexThreadConfig | null | undefined)?.notifyOnTurnFinish;
  return typeof value === "boolean" ? value : undefined;
}

export function buildCodexTurnNoticeOptions(opts: {
  account_id: string;
  source_project_id: string;
  source_path: string;
  source_fragment_id?: string;
  thread_id: string;
  thread_label?: string | null;
  stable_source_id?: string;
  terminal_state: CodexTurnTerminalState;
  error_text?: string | null;
  // "Codex", "Claude", ... (default "Agent").
  agent_label?: string;
}): CreateCodexTurnNoticeOptions {
  const threadLabel = normalizeThreadLabel(opts.thread_label);
  const agent = `${opts.agent_label ?? ""}`.trim() || "Agent";
  const severity: NotificationSeverity =
    opts.terminal_state === "error" ? "warning" : "info";
  const title =
    opts.terminal_state === "error"
      ? `${agent} turn ended with an error`
      : `${agent} turn finished`;
  const details = normalizeErrorText(opts.error_text);
  const body_markdown =
    opts.terminal_state === "error"
      ? details
        ? `${agent} finished with an error in **${threadLabel}**.\n\n${details}`
        : `${agent} finished with an error in **${threadLabel}**.`
      : `${agent} finished working in **${threadLabel}**.`;
  return {
    account_id: opts.account_id,
    source_project_id: opts.source_project_id,
    source_path: opts.source_path,
    source_fragment_id: opts.source_fragment_id,
    thread_id: opts.thread_id,
    thread_label: threadLabel,
    title,
    body_markdown,
    severity,
    stable_source_id: `${opts.stable_source_id ?? ""}`.trim() || undefined,
  };
}

export async function publishCodexTurnNotice(opts: {
  client: ConatClient;
  project_id: string;
  notice: CreateCodexTurnNoticeOptions;
}): Promise<void> {
  await callHub({
    client: opts.client,
    project_id: opts.project_id,
    name: "notifications.createCodexTurnNotice",
    args: [opts.notice],
    timeout: CODEX_TURN_NOTICE_TIMEOUT_MS,
  });
}
