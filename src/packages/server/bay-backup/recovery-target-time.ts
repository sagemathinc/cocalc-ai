/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const RFC3339_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

// Canonicalize an RFC3339 recovery target to UTC ("...Z") without losing
// precision: PostgreSQL timestamps have microseconds, while a JavaScript Date
// keeps only milliseconds. Rounding a target down to the millisecond can move
// it before a transaction committed in that same millisecond (the restore
// drill's "pre" sentinel), so fractions are kept up to microseconds. Inputs
// with at most three fractional digits keep the familiar millisecond form.
export function normalizeRecoveryTargetTime(value?: string): string | null {
  const trimmed = `${value ?? ""}`.trim();
  if (trimmed === "") {
    return null;
  }
  const match = RFC3339_RE.exec(trimmed);
  if (!match) {
    throw new Error(
      "target_time must be an RFC3339 timestamp with an explicit timezone, e.g. 2026-04-07T15:37:57Z",
    );
  }
  const [, wholeSeconds, fraction = "", zone] = match;
  const parsed = new Date(`${wholeSeconds}${zone}`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`invalid target_time '${trimmed}'`);
  }
  // Offsets are whole minutes, so only the whole seconds need converting.
  const digits =
    fraction.length <= 3 ? fraction.padEnd(3, "0") : fraction.slice(0, 6);
  return `${parsed.toISOString().slice(0, 19)}.${digits}Z`;
}

// "2026-10-13 05:28:46.602286+00", as PostgreSQL's recovery_target_time.
export function formatRecoveryTargetTimeForPostgres(value: string): string {
  return value.replace("T", " ").replace("Z", "+00");
}
