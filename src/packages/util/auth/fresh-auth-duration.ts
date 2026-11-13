/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
How long a fresh auth (a re-entered password or second factor) stays active.

- "default": 15 minutes; any verification.
- "extended": 8 hours; needs a TOTP, passkey or Google verification.
- "<N>h" with 1 <= N <= 72: N hours; the same factors as "extended". For
  someone who must be able to act (an outage, a security issue) while away for
  a long weekend. A fresh auth longer than 8 hours sends the account an email,
  and every active one can be ended at any time (see auth/fresh-auth/end).

The value travels as this string everywhere (the CLI, the browser, the API, and
the varchar(32) requested_duration column of a CLI auth challenge).
*/

export const FRESH_AUTH_DEFAULT_MS = 15 * 60_000;
export const FRESH_AUTH_EXTENDED_MS = 8 * 60 * 60_000;
export const FRESH_AUTH_MAX_HOURS = 72;
const HOUR_MS = 60 * 60_000;

export type FreshAuthHours = `${number}h`;
export type FreshAuthDuration = "default" | "extended" | FreshAuthHours;

// The choices offered in the browser and documented for the CLI.
export const FRESH_AUTH_DURATION_CHOICES: readonly FreshAuthDuration[] = [
  "default",
  "extended",
  "24h",
  "72h",
];

export class InvalidFreshAuthDurationError extends Error {
  code = "invalid_fresh_auth_duration";
  constructor(value: unknown) {
    super(
      `invalid fresh auth duration ${JSON.stringify(`${value ?? ""}`.slice(0, 40))}: use default, extended, or 1h to ${FRESH_AUTH_MAX_HOURS}h`,
    );
  }
}

// A missing value is "default". Anything that is not one of the forms above
// throws, so a typo never silently becomes a different duration.
export function parseFreshAuthDuration(value: unknown): FreshAuthDuration {
  if (value == null) return "default";
  const s = `${value}`.trim().toLowerCase();
  if (s === "" || s === "default") return "default";
  if (s === "extended") return "extended";
  const m = /^([1-9][0-9]?)h$/.exec(s);
  if (m) {
    const hours = Number(m[1]);
    if (hours <= FRESH_AUTH_MAX_HOURS) return `${hours}h`;
  }
  throw new InvalidFreshAuthDurationError(value);
}

export function freshAuthDurationMs(duration?: FreshAuthDuration): number {
  const d = parseFreshAuthDuration(duration);
  if (d === "default") return FRESH_AUTH_DEFAULT_MS;
  if (d === "extended") return FRESH_AUTH_EXTENDED_MS;
  return Number(d.slice(0, -1)) * HOUR_MS;
}

// Everything longer than the 15-minute default needs a TOTP, passkey or
// Google verification.
export function freshAuthDurationNeedsStrongFactor(
  duration?: FreshAuthDuration,
): boolean {
  return parseFreshAuthDuration(duration) !== "default";
}

// Longer than "extended": the account gets an email when one is granted.
export function isLongFreshAuthDuration(duration?: FreshAuthDuration): boolean {
  return freshAuthDurationMs(duration) > FRESH_AUTH_EXTENDED_MS;
}

export function formatFreshAuthDuration(duration?: FreshAuthDuration): string {
  const ms = freshAuthDurationMs(duration);
  if (ms < HOUR_MS) return `${Math.round(ms / 60_000)} minutes`;
  const hours = ms / HOUR_MS;
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

// "71 h 59 min", "14 min", "45 s": the time left until `until`, for a
// countdown. Returns "" once it has passed.
export function formatFreshAuthRemaining(
  until: Date | string | null | undefined,
  now: number = Date.now(),
): string {
  if (until == null) return "";
  const end = new Date(until).valueOf();
  if (!Number.isFinite(end)) return "";
  const left = end - now;
  if (left <= 0) return "";
  const totalMinutes = Math.floor(left / 60_000);
  if (totalMinutes < 1) return `${Math.ceil(left / 1000)} s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`;
}
