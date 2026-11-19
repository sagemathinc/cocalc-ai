/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// One rule, in code and in SQL, for times in Claude credential metadata
// (util/ai/claude-usage-probe.ts and server/agents/claude-usage-probe.ts;
// the index in db-schema/external-credentials.ts uses the same expression).
// Metadata is not trusted to be well formed: a time counts only when it is
// exactly what toISOString writes for a real date, and these sort in time
// order as text. No expression here can fail a query.

const LEAP_YEAR =
  "([0-9]{2}(0[48]|[2468][048]|[13579][26])|([02468][048]|[13579][26])00)";
const DATE =
  "([0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|1[0-9]|2[0-8])" +
  "|[0-9]{4}-(0[13-9]|1[0-2])-(29|30)" +
  "|[0-9]{4}-(0[13578]|1[02])-31" +
  `|${LEAP_YEAR}-02-29)`;
const TIME = "([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\\.[0-9]{3}";

/** A time as toISOString writes it (years 0000 to 9999), as a regex. */
export const ISO_TIME_PATTERN = `^${DATE}T${TIME}Z$`;
const ISO_TIME = new RegExp(ISO_TIME_PATTERN);

/** Whether `value` is a time exactly as toISOString writes it. */
export function isIsoTime(value: unknown): value is string {
  return typeof value === "string" && ISO_TIME.test(value);
}

/** SQL: the time `text` holds, or "" when it is absent or not such a time
 * (which compares as older than any time). */
export function isoTimeSql(text: string): string {
  return `(CASE WHEN ${text} ~ '${ISO_TIME_PATTERN}' THEN ${text} ELSE '' END)`;
}

/** SQL: when the subscription's reading was taken ("" if none). */
export function claudeReadingAtSql(table?: string): string {
  const metadata = table ? `${table}.metadata` : "metadata";
  return isoTimeSql(`(${metadata}->'claude_usage'->>'observed_at')`);
}
