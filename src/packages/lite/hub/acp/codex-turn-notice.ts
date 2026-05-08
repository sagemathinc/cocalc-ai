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
  return config?.notifyOnTurnFinish === true;
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
}): CreateCodexTurnNoticeOptions {
  const threadLabel = normalizeThreadLabel(opts.thread_label);
  const severity: NotificationSeverity =
    opts.terminal_state === "error" ? "warning" : "info";
  const title =
    opts.terminal_state === "error"
      ? "Codex turn ended with an error"
      : "Codex turn finished";
  const details = normalizeErrorText(opts.error_text);
  const body_markdown =
    opts.terminal_state === "error"
      ? details
        ? `Codex finished with an error in **${threadLabel}**.\n\n${details}`
        : `Codex finished with an error in **${threadLabel}**.`
      : `Codex finished working in **${threadLabel}**.`;
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
  });
}
