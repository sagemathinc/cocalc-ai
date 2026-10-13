/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Public auth pages (sign-in, the OAuth approval page, CLI approval, ...) are
// served as the public shell with ?target=<path>. They must never be framed:
// a framed approval page could be clickjacked.

/** Whether the public shell's target is a public auth page. The target is
 * classified the way the browser's public app reads it: the first `target`
 * parameter, resolved with `new URL`, which normalizes dot segments, and any
 * `auth` path segment (the app's router looks for one anywhere in the path). */
export function isPublicAuthShellTarget(target: unknown): boolean {
  const value = Array.isArray(target) ? target[0] : target;
  if (typeof value !== "string" || !value) return false;
  let url: URL;
  try {
    url = new URL(value, "https://example.invalid");
  } catch {
    return false;
  }
  return url.pathname.split("/").filter(Boolean).includes("auth");
}
