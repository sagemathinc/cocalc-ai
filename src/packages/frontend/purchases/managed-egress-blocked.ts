/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export interface ManagedEgressBlockedInfo {
  raw: string;
  title: string;
  details: string[];
}

const MANAGED_EGRESS_BLOCK_PATTERNS = [
  "Current managed egress categories",
  "egress usage window resets",
  "traffic is temporarily blocked",
  "managed egress",
  "limit reached for this account",
];

export function parseManagedEgressBlockedError(
  error: string | undefined | null,
): ManagedEgressBlockedInfo | undefined {
  if (!error) return;
  const raw = `${error}`.trim();
  if (!raw) return;
  const lower = raw.toLowerCase();
  if (
    !MANAGED_EGRESS_BLOCK_PATTERNS.some((pattern) =>
      lower.includes(pattern.toLowerCase()),
    )
  ) {
    return;
  }
  const normalized = raw.replace(/^failed to sign in\s*-\s*error:\s*/i, "");
  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return;
  const [title, ...details] = lines;
  return { raw, title, details };
}
