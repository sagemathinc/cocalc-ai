/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The metadata a project-host report (register or heartbeat) may write.
//
// project_hosts.metadata holds two kinds of state: what the host reports about
// itself, and the bay's own control state (billing, desired_state, the probe
// quarantines, restart recovery, ...). upsertProjectHost merges a report into
// the stored object with jsonb `||`, so any top-level key a report carries
// replaces the stored one. A report is therefore reduced to the keys a host
// owns (an allow-list: a key the bay adds later is protected by default), and
// each kept value must be plain JSON within fixed size and depth budgets.
// Values are never logged.
//
// The keys are exactly what project-host/master.ts sends: basePayload.metadata
// plus buildPayload's metadata. A key a host of another version sends is
// dropped and counted; that costs a host-reported field, never bay state.

type Kind = "string" | "number" | "boolean" | "object" | "array";

// key -> the JSON kinds its value may have (null is always allowed).
const HOST_REPORTED_METADATA: Record<string, readonly Kind[]> = {
  runnerId: ["string"],
  host_session_id: ["string"],
  host_boot_id: ["string"],
  host_session_started_at: ["string"],
  host_boot_started_at: ["string"],
  host_cpu_count: ["number"],
  host_ram_gb: ["number"],
  host_uptime_s: ["number"],
  cloudflared: ["object"],
  cloudflared_restart_supported: ["boolean"],
  cloudflared_diagnostics_supported: ["boolean"],
  metrics: ["object"],
  pressure: ["object"],
  placement: ["object"],
  bootstrap_lifecycle: ["object"],
  host_agent: ["object"],
  runtime_health: ["object"],
  acp_worker_health: ["object"],
  bees: ["object"],
  host_integrity: ["object"],
  runtime_uid_mode: ["object"],
  observed_components: ["array"],
  rootfs_scanner: ["object"],
  software: ["object"],
  software_inventory: ["array"],
  agent_rpc_report: ["object"],
  content_origin_domain: ["string"],
};

export const HOST_REPORTED_METADATA_KEYS: readonly string[] = Object.freeze(
  Object.keys(HOST_REPORTED_METADATA),
);

export const HOST_REPORT_METADATA_LIMITS = Object.freeze({
  // Checked before any per-key work.
  maxTopLevelKeys: 64,
  // Budgets of the bounded walk over all kept values together.
  maxNodes: 50_000,
  maxBytes: 512 * 1024,
  // Per value.
  maxDepth: 8,
  maxStringLength: 8 * 1024,
  maxKeyLength: 128,
});

// Fixed labels only: one per allow-listed key, plus aggregate buckets. A
// host-chosen key name never becomes a label, map key or log line.
export type HostReportMetadataDropReason =
  | "not_object"
  | "too_many_keys"
  | "over_budget"
  | "unknown_key"
  | "invalid_value";

const dropCounts = new Map<string, number>();

function countDrop(reason: HostReportMetadataDropReason, key?: string): void {
  const label = key ? `${reason}:${key}` : reason;
  dropCounts.set(label, (dropCounts.get(label) ?? 0) + 1);
}

// For tests and diagnostics: labels are fixed strings, values are counts.
export function getHostReportMetadataDropCounts(): Record<string, number> {
  return Object.fromEntries(dropCounts);
}

export function resetHostReportMetadataDropCountsForTests(): void {
  dropCounts.clear();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function kindOf(value: unknown): Kind | "null" | undefined {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "number") {
    return Number.isFinite(value) ? "number" : undefined;
  }
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) return "array";
  if (isPlainObject(value)) return "object";
  return undefined;
}

type Budget = { nodes: number; bytes: number };

// Walks a value iteratively with explicit depth, node and byte budgets, so a
// deep or huge value is rejected without recursion or serialization. Returns
// false when the value is not plain JSON or exceeds a budget.
function withinBudget(root: unknown, budget: Budget): boolean {
  const limits = HOST_REPORT_METADATA_LIMITS;
  const stack: Array<{ value: unknown; depth: number }> = [
    { value: root, depth: 0 },
  ];
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    budget.nodes += 1;
    if (budget.nodes > limits.maxNodes) return false;
    const kind = kindOf(value);
    if (kind == null) return false;
    if (kind === "string") {
      const length = (value as string).length;
      if (length > limits.maxStringLength) return false;
      budget.bytes += length;
    } else if (kind === "array" || kind === "object") {
      if (depth >= limits.maxDepth) return false;
      if (kind === "array") {
        for (const item of value as unknown[]) {
          stack.push({ value: item, depth: depth + 1 });
        }
      } else {
        for (const [key, item] of Object.entries(
          value as Record<string, unknown>,
        )) {
          if (key.length > limits.maxKeyLength) return false;
          budget.bytes += key.length;
          stack.push({ value: item, depth: depth + 1 });
        }
      }
    } else {
      budget.bytes += 8;
    }
    if (budget.bytes > limits.maxBytes) return false;
  }
  return true;
}

// The report's metadata reduced to the host-owned keys with valid values.
// Anything that is not a plain object yields {} (nothing is merged).
export function pickHostReportedMetadata(
  metadata: unknown,
): Record<string, unknown> {
  if (metadata === undefined) return {};
  if (!isPlainObject(metadata)) {
    countDrop("not_object");
    return {};
  }
  const keys = Object.keys(metadata);
  if (keys.length > HOST_REPORT_METADATA_LIMITS.maxTopLevelKeys) {
    countDrop("too_many_keys");
    return {};
  }
  const picked: Record<string, unknown> = {};
  const budget: Budget = { nodes: 0, bytes: 0 };
  for (const key of keys) {
    const kinds = Object.prototype.hasOwnProperty.call(
      HOST_REPORTED_METADATA,
      key,
    )
      ? HOST_REPORTED_METADATA[key]
      : undefined;
    if (kinds == null) {
      countDrop("unknown_key");
      continue;
    }
    const value = metadata[key];
    if (value === undefined) continue;
    const kind = kindOf(value);
    if (kind == null || (kind !== "null" && !kinds.includes(kind))) {
      countDrop("invalid_value", key);
      continue;
    }
    const before = { ...budget };
    if (!withinBudget(value, budget)) {
      // The whole report is over budget: keep nothing from it.
      if (
        budget.nodes > HOST_REPORT_METADATA_LIMITS.maxNodes ||
        budget.bytes > HOST_REPORT_METADATA_LIMITS.maxBytes
      ) {
        countDrop("over_budget");
        return {};
      }
      budget.nodes = before.nodes;
      budget.bytes = before.bytes;
      countDrop("invalid_value", key);
      continue;
    }
    picked[key] = value;
  }
  return picked;
}
