/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties, JSX } from "react";
import type { IFileContext } from "@cocalc/frontend/lib/file-context";
import Markdown from "@cocalc/frontend/editors/slate/static-markdown";
import { withViewerFileContext } from "../viewer-file-context";

type ChatRow = {
  event?: string;
  sender_id?: string;
  date?: string | number;
  history?: Array<{ author_id?: string; content?: string; date?: string }>;
  name?: string;
  thread_id?: string;
};

function formatDate(value: unknown): string | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return new Date(value).toLocaleString();
  }
  const raw = `${value ?? ""}`.trim();
  if (!raw) return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.valueOf())) return raw;
  return date.toLocaleString();
}

function escapeInline(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+\-.!|>]/g, "\\$&");
}

function buildChatMarkdown(content: string): string {
  const lines = content.split(/\r?\n/);
  const rows: ChatRow[] = [];
  const threadNames = new Map<string, string>();

  for (const line of lines) {
    const raw = line.trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as ChatRow;
      if (parsed.event === "chat-thread-config" && parsed.thread_id) {
        const name = `${parsed.name ?? ""}`.trim();
        if (name) {
          threadNames.set(parsed.thread_id, name);
        }
      }
      if (parsed.event === "chat") {
        rows.push(parsed);
      }
    } catch {
      continue;
    }
  }

  rows.sort((a, b) => {
    const left = new Date(`${a.date ?? ""}`).valueOf();
    const right = new Date(`${b.date ?? ""}`).valueOf();
    return left - right;
  });

  if (rows.length === 0) {
    return "No chat messages were found in this file.";
  }

  const out: string[] = [];
  let lastThreadId: string | undefined;
  for (const row of rows) {
    const latest = Array.isArray(row.history) ? row.history[0] : undefined;
    const message = `${latest?.content ?? ""}`.trim();
    if (!message) continue;

    const threadId = `${row.thread_id ?? ""}`.trim() || undefined;
    if (threadId && threadId !== lastThreadId) {
      const threadName = threadNames.get(threadId);
      out.push(
        `## ${escapeInline(threadName || "Thread")} \`${escapeInline(threadId)}\``,
      );
      out.push("");
      lastThreadId = threadId;
    }

    const author =
      `${latest?.author_id ?? row.sender_id ?? "unknown"}`.trim() || "unknown";
    const when = formatDate(latest?.date ?? row.date);
    out.push(`### ${escapeInline(author)}`);
    if (when) {
      out.push(`*${escapeInline(when)}*`);
      out.push("");
    }
    out.push(message);
    out.push("");
    out.push("---");
    out.push("");
  }

  const markdown = out.join("\n").trim();
  return markdown || "No chat messages were found in this file.";
}

export default function PublicViewerChatRenderer({
  content,
  style,
  fileContext,
}: {
  content: string;
  style?: CSSProperties;
  fileContext: IFileContext;
}): JSX.Element {
  return withViewerFileContext(
    <Markdown value={buildChatMarkdown(content)} style={style} />,
    fileContext,
  );
}
