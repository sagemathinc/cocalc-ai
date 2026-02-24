/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export interface ChatPreviewParseResult {
  rows: Record<string, unknown>[];
  parsedRows: number;
  parseErrors: number;
}

// Parse chat syncdoc JSON-lines content from disk. Invalid lines are skipped.
export function parseChatPreviewRows(raw: string): ChatPreviewParseResult {
  if (typeof raw !== "string" || raw.length === 0) {
    return { rows: [], parsedRows: 0, parseErrors: 0 };
  }
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
