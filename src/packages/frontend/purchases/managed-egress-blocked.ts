/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { parseManagedEgressBlockedMessage } from "@cocalc/util/managed-egress-message";

export interface ManagedEgressBlockedInfo {
  raw: string;
  title: string;
  details: string[];
  category?: string;
  window?: "5h" | "7d";
  resets_at?: string;
}

// Older servers sent block messages without the code line; keep recognizing
// those during a rolling upgrade.
const MANAGED_EGRESS_BLOCK_PATTERNS = [
  "Current managed egress categories",
  "egress usage window resets",
  "traffic is temporarily blocked",
  "managed egress",
  "limit reached for this account",
  "traffic safety limit reached",
];

export function parseManagedEgressBlockedError(
  error: string | undefined | null,
): ManagedEgressBlockedInfo | undefined {
  if (!error) return;
  const raw = `${error}`.trim();
  if (!raw) return;
  const parsed = parseManagedEgressBlockedMessage(raw);
  if (parsed != null) {
    return { raw, ...parsed };
  }
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
  // The old control-plane message ("Account control traffic safety limit
  // reached.") had no category; a membership upgrade does not raise it.
  const category =
    lower.includes("account control traffic") ||
    lower.includes("control-plane connections")
      ? "control-plane-conat"
      : undefined;
  return { raw, title, details, ...(category ? { category } : {}) };
}

// Whether upgrading the membership raises the limit that blocked: not for
// the independent control-plane safety limit (contact support instead).
export function managedEgressBlockUpgradeHelps(
  info: Pick<ManagedEgressBlockedInfo, "category">,
): boolean {
  return info.category !== "control-plane-conat";
}
