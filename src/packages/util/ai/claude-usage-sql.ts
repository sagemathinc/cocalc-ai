/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// SQL over Claude credential metadata (server/agents/claude-usage-probe.ts,
// and the index in db-schema/external-credentials.ts, which must use the
// same expression). Metadata is not trusted to be well formed: no expression
// here can fail the query.

// An ISO time as toISOString writes it: these sort in time order as text.
const ISO_TIME =
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?Z$";

/** The ISO time `text` holds, or "" when it is absent or malformed, which
 * compares as older than any time. */
export function isoTimeSql(text: string): string {
  return `(CASE WHEN ${text} ~ '${ISO_TIME}' THEN ${text} ELSE '' END)`;
}

/** When the subscription's reading was taken ("" if none). */
export function claudeReadingAtSql(table?: string): string {
  const metadata = table ? `${table}.metadata` : "metadata";
  return isoTimeSql(`(${metadata}->'claude_usage'->>'observed_at')`);
}
