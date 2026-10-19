/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { capitalize, humanSize } from "./misc";

export interface ManagedEgressPolicySummary {
  blocked_by?: "5h" | "7d";
  managed_egress_5h_bytes?: number;
  managed_egress_7d_bytes?: number;
  egress_5h_bytes?: number;
  egress_7d_bytes?: number;
  managed_egress_categories_5h_bytes?: Record<string, number>;
  managed_egress_categories_7d_bytes?: Record<string, number>;
}

function formatManagedEgressCategory(category: string): string {
  if (category === "file-download") return "File downloads";
  if (category === "http-proxy") return "App server HTTP traffic";
  if (category === "ws-proxy") return "App server WebSocket traffic";
  if (category === "ssh") return "SSH traffic";
  if (category === "interactive-conat") return "Interactive session traffic";
  if (category === "control-plane-conat") return "Account control traffic";
  if (category === "backup-upload") return "Project backup uploads";
  if (category === "raw-network") return "Project outbound network traffic";
  return capitalize(category.replace(/[-_]/g, " "));
}

function formatByteCount(bytes: number | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
    return "unknown";
  }
  return humanSize(bytes);
}

function formatCategoryBreakdown(
  categories: Record<string, number> | undefined,
): string | undefined {
  const breakdown = Object.entries(categories ?? {})
    .filter(
      ([, bytes]) =>
        typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0,
    )
    .map(
      ([category, bytes]) =>
        `${formatManagedEgressCategory(category)}: ${formatByteCount(bytes)}`,
    );
  return breakdown.length > 0 ? breakdown.join(", ") : undefined;
}

export function formatManagedEgressPolicyDetails(
  policy: ManagedEgressPolicySummary,
): string[] {
  const lines: string[] = [];
  if (policy.blocked_by === "5h") {
    lines.push("Limit triggered by the 5-hour network usage window.");
  } else if (policy.blocked_by === "7d") {
    lines.push("Limit triggered by the 7-day network usage window.");
  }
  if (policy.egress_5h_bytes != null) {
    lines.push(
      `5-hour usage: ${formatByteCount(policy.managed_egress_5h_bytes ?? 0)} / ${formatByteCount(policy.egress_5h_bytes)}.`,
    );
  }
  if (policy.egress_7d_bytes != null) {
    lines.push(
      `7-day usage: ${formatByteCount(policy.managed_egress_7d_bytes ?? 0)} / ${formatByteCount(policy.egress_7d_bytes)}.`,
    );
  }
  const breakdown5h = formatCategoryBreakdown(
    policy.managed_egress_categories_5h_bytes,
  );
  if (breakdown5h) {
    lines.push(`5-hour network usage by category: ${breakdown5h}.`);
  }
  const breakdown7d = formatCategoryBreakdown(
    policy.managed_egress_categories_7d_bytes,
  );
  if (breakdown7d) {
    lines.push(`7-day network usage by category: ${breakdown7d}.`);
  }
  return lines;
}

// Every managed-egress block uses this format, so the UI and the CLI can
// always recognize it and show a specific message instead of a generic
// sign-in or connection error.
export const MANAGED_EGRESS_BLOCK_CODE = "managed-egress-blocked";

export interface ManagedEgressBlockedPolicy extends ManagedEgressPolicySummary {
  // When the blocking window drops back under its limit, if known.
  blocked_until?: Date | string;
}

const WINDOW_LENGTH = { "5h": "5 hours", "7d": "7 days" } as const;

function formatResetLine(
  policy: ManagedEgressBlockedPolicy,
  now: Date,
): string | undefined {
  const until =
    policy.blocked_until != null ? new Date(policy.blocked_until) : undefined;
  if (until != null && Number.isFinite(until.getTime())) {
    const ms = Math.max(0, until.getTime() - now.getTime());
    const minutes = Math.ceil(ms / 60_000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const mins = minutes % 60;
    const parts = [
      days > 0 ? `${days} day${days == 1 ? "" : "s"}` : "",
      hours > 0 ? `${hours} hour${hours == 1 ? "" : "s"}` : "",
      days == 0 && mins > 0 ? `${mins} minute${mins == 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    const relative = parts.length > 0 ? ` (in about ${parts.join(" ")})` : "";
    return `It resets at ${until.toISOString()}${relative}.`;
  }
  if (policy.blocked_by != null) {
    return `It resets as usage older than ${WINDOW_LENGTH[policy.blocked_by]} leaves the window.`;
  }
  return undefined;
}

export function formatManagedEgressBlockedMessage({
  category,
  policy,
  blocked,
  now = new Date(),
}: {
  category: string;
  policy: ManagedEgressBlockedPolicy;
  // What is blocked, as a sentence, e.g. "New browser sessions are blocked."
  blocked: string;
  now?: Date;
}): string {
  const until =
    policy.blocked_until != null ? new Date(policy.blocked_until) : undefined;
  const code = [
    `Code: ${MANAGED_EGRESS_BLOCK_CODE}`,
    `category=${category}`,
    ...(policy.blocked_by ? [`window=${policy.blocked_by}`] : []),
    ...(until != null && Number.isFinite(until.getTime())
      ? [`resets_at=${until.toISOString()}`]
      : []),
  ].join(" ");
  return [
    `${formatManagedEgressCategory(category)} limit reached for this account.`,
    blocked,
    ...formatManagedEgressPolicyDetails(policy),
    formatResetLine(policy, now),
    "What to do: wait until it resets, or contact support to have the limit raised.",
    code,
  ]
    .filter((line): line is string => !!line)
    .join("\n");
}

export interface ParsedManagedEgressBlock {
  category: string;
  window?: "5h" | "7d";
  resets_at?: string;
  title: string;
  details: string[];
}

// Recognizes a block message by its code line, wherever it ends up: a
// handshake error, an HTTP body, a WebSocket close reason or a CLI error
// (with or without a "failed to sign in - Error: " style prefix).
export function parseManagedEgressBlockedMessage(
  text: unknown,
): ParsedManagedEgressBlock | undefined {
  if (text == null) return;
  const raw = `${text}`;
  const match = raw.match(
    new RegExp(`Code: ${MANAGED_EGRESS_BLOCK_CODE}((?: [a-z_]+=[^\\s]+)*)`),
  );
  if (!match) return;
  const fields: Record<string, string> = {};
  for (const pair of match[1].trim().split(/\s+/).filter(Boolean)) {
    const i = pair.indexOf("=");
    fields[pair.slice(0, i)] = pair.slice(i + 1);
  }
  if (!fields.category) return;
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("Code: "));
  // Drop anything before the title line, and any "...Error: " prefix on it.
  const start = lines.findIndex((line) =>
    line.includes("limit reached for this account."),
  );
  const [first = "Network usage limit reached.", ...details] =
    start >= 0 ? lines.slice(start) : lines;
  const title = first.replace(/^.*\berror:\s*/i, "");
  const window =
    fields.window === "5h" || fields.window === "7d"
      ? fields.window
      : undefined;
  return {
    category: fields.category,
    window,
    resets_at: fields.resets_at,
    title,
    details,
  };
}
