/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties, JSX } from "react";
import type { IFileContext } from "@cocalc/frontend/lib/file-context";
import Markdown from "@cocalc/frontend/editors/slate/static-markdown-public";
import { normalizeChatMessage } from "@cocalc/frontend/chat/normalize";
import { from_str } from "@cocalc/sync/editor/immer-db/doc";
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
  const { rows, threadNames } = parseChatRows(content);

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

function parseChatRows(content: string): {
  rows: ChatRow[];
  threadNames: Map<string, string>;
} {
  const parsed = parseImmerChatRows(content);
  if (parsed.rows.length > 0 || parsed.threadNames.size > 0) {
    return parsed;
  }
  return parseJsonLineChatRows(content);
}

function parseImmerChatRows(content: string): {
  rows: ChatRow[];
  threadNames: Map<string, string>;
} {
  const rows: ChatRow[] = [];
  const threadNames = new Map<string, string>();
  try {
    const doc = from_str(
      content,
      ["date", "sender_id", "event", "message_id", "thread_id"],
      ["input"],
    );
    for (const raw of doc.get() ?? []) {
      const row =
        typeof raw?.toJS === "function" ? (raw.toJS() as ChatRow) : raw;
      recordChatRow({ row, rows, threadNames });
    }
  } catch {
    // Older exported chat fixtures are JSONL; fall back below.
  }
  return { rows, threadNames };
}

function parseJsonLineChatRows(content: string): {
  rows: ChatRow[];
  threadNames: Map<string, string>;
} {
  const rows: ChatRow[] = [];
  const threadNames = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw) continue;
    try {
      recordChatRow({ row: JSON.parse(raw) as ChatRow, rows, threadNames });
    } catch {
      continue;
    }
  }
  return { rows, threadNames };
}

function recordChatRow({
  row,
  rows,
  threadNames,
}: {
  row: ChatRow;
  rows: ChatRow[];
  threadNames: Map<string, string>;
}): void {
  if (row?.event === "chat-thread-config" && row.thread_id) {
    const name = `${row.name ?? ""}`.trim();
    if (name) {
      threadNames.set(row.thread_id, name);
    }
  }
  if (row?.event === "chat") {
    const normalized = normalizeChatMessage(row).message ?? row;
    rows.push(normalized as ChatRow);
  }
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
