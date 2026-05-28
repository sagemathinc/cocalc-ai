/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { from_str } from "@cocalc/sync/editor/immer-db/doc";

export interface ChatPreviewParseResult {
  rows: Record<string, unknown>[];
  parsedRows: number;
  parseErrors: number;
}

const CHAT_PRIMARY_KEYS = [
  "date",
  "sender_id",
  "event",
  "message_id",
  "thread_id",
];
const CHAT_STRING_COLS = ["input"];

function parseNativeChatRows(raw: string): Record<string, unknown>[] | null {
  try {
    const doc = from_str(raw, CHAT_PRIMARY_KEYS, CHAT_STRING_COLS);
    const rows = doc.get();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return rows
      .map((row) =>
        typeof (row as any)?.toJS === "function"
          ? ((row as any).toJS() as Record<string, unknown>)
          : (row as Record<string, unknown>),
      )
      .filter((row) => row != null && typeof row === "object");
  } catch {
    return null;
  }
}

function parseJsonLineChatRows(raw: string): ChatPreviewParseResult {
  const rows: Record<string, unknown>[] = [];
  let parseErrors = 0;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed != null && typeof parsed === "object") {
        rows.push(parsed as Record<string, unknown>);
      }
    } catch {
      parseErrors += 1;
    }
  }
  return {
    rows,
    parsedRows: rows.length,
    parseErrors,
  };
}

// Parse chat syncdoc content from disk. Native Immer syncdocs are preferred;
// older JSON-lines exports are still supported for public/static viewers.
export function parseChatPreviewRows(raw: string): ChatPreviewParseResult {
  if (typeof raw !== "string" || raw.length === 0) {
    return { rows: [], parsedRows: 0, parseErrors: 0 };
  }
  const jsonLines = parseJsonLineChatRows(raw);
  if (jsonLines.parsedRows > 0 || jsonLines.parseErrors > 0) {
    return jsonLines;
  }
  const nativeRows = parseNativeChatRows(raw);
  if (nativeRows != null) {
    return {
      rows: nativeRows,
      parsedRows: nativeRows.length,
      parseErrors: 0,
    };
  }
  return jsonLines;
}
