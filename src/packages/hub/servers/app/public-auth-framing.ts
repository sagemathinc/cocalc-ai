/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Public auth pages (sign-in, the OAuth approval page, CLI approval, project
// invites, single sign-on, ...) are served as the public shell, at their own
// path or as ?target=<path>. They must never be framed: a framed approval or
// invite page could be clickjacked.

// The public app's auth section: frontend/public/routes.ts.
const AUTH_SECTION_SEGMENTS = new Set(["auth", "invites", "sso", "redeem"]);

/** Whether the public shell's target is a public auth page. The target is
 * classified the way the browser's public app reads it: the first `target`
 * parameter, resolved with `new URL`, which normalizes dot segments, and any
 * auth-section path segment (the app's router looks for one anywhere in the
 * path). */
export function isPublicAuthShellTarget(target: unknown): boolean {
  const value = Array.isArray(target) ? target[0] : target;
  if (typeof value !== "string" || !value) return false;
  let url: URL;
  try {
    url = new URL(value, "https://example.invalid");
  } catch {
    return false;
  }
  return url.pathname
    .split("/")
    .filter(Boolean)
    .some((segment) => AUTH_SECTION_SEGMENTS.has(segment));
}
