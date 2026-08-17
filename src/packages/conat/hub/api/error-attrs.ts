/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const HUB_API_ERROR_ATTR_KEYS = [
  "code",
  "subject",
  "request_id",
  "grant_id",
  "approval_url",
  "expires_at",
  "project_id",
] as const;

export function hubApiErrorAttrs(error: unknown): Record<string, unknown> {
  const source =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    HUB_API_ERROR_ATTR_KEYS.flatMap((key) => {
      const value = source[key];
      return value == null ? [] : [[key, value]];
    }),
  );
}
