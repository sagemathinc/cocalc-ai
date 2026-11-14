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

// key -> the JSON kinds its value may have (null is always allowed). The
// order is the order keys are checked and charged: identity and session keys
// first, the large blobs last, so a big value can never cost a report its
// identity (restart recovery and routing depend on it).
const HOST_REPORTED_METADATA: Record<string, readonly Kind[]> = {
  runnerId: ["string"],
  host_session_id: ["string"],
  host_boot_id: ["string"],
  host_session_started_at: ["string"],
  host_boot_started_at: ["string"],
  host_cpu_count: ["number"],
  host_ram_gb: ["number"],
  host_uptime_s: ["number"],
  cloudflared_restart_supported: ["boolean"],
  cloudflared_diagnostics_supported: ["boolean"],
  content_origin_domain: ["string"],
  agent_rpc_report: ["object"],
  software: ["object"],
  runtime_uid_mode: ["object"],
  host_integrity: ["object"],
  runtime_health: ["object"],
  bootstrap_lifecycle: ["object"],
  pressure: ["object"],
  host_agent: ["object"],
  acp_worker_health: ["object"],
  bees: ["object"],
  rootfs_scanner: ["object"],
  observed_components: ["array"],
  software_inventory: ["array"],
  placement: ["object"],
  cloudflared: ["object"],
  metrics: ["object"],
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
  // A single value's share of those budgets, so one blob cannot use them up.
  maxNodesPerKey: 20_000,
  maxBytesPerKey: 256 * 1024,
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
  | "unknown_key"
  | "invalid_value"
  | "over_budget";

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

// Usage so far and the caps it may reach.
type Budget = {
  nodes: number;
  bytes: number;
  maxNodes: number;
  maxBytes: number;
};

type Frame =
  | { kind: "array"; value: unknown[]; index: number; depth: number }
  | {
      kind: "object";
      value: Record<string, unknown>;
      keys: Iterator<string>;
      depth: number;
    };

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

// Own keys one at a time, so this code never copies a wide object into a key
// or entry array. The engine still enumerates an object's keys when a for-in
// loop starts, so that step is linear in the object's width. The width is
// bounded only by what the server received and decoded: conat has no overall
// message size limit (conat/core/client.ts: messages are chunked into frames
// of at most MAX_PAYLOAD, 8 MB, conat/core/constants.ts; reassembly is limited
// by time, not size).
function* ownKeys(value: Record<string, unknown>): Generator<string> {
  for (const key in value) {
    if (hasOwn(value, key)) yield key;
  }
}

// Walks a value with explicit depth, node and byte budgets: each child is
// read and charged one at a time before anything below it is visited, the
// stack holds at most maxDepth frames, and the walk stops at the first value
// over a budget. So the values read and the walk's memory are bounded by the
// budgets, not by the width or depth a host chooses; only the engine's key
// enumeration of an object (see ownKeys) is linear in its width. Returns
// false when the value is not plain JSON or exceeds a budget.
function withinBudget(root: unknown, budget: Budget): boolean {
  const limits = HOST_REPORT_METADATA_LIMITS;
  const stack: Frame[] = [];
  // Charges one value; a container gets a frame for its children.
  const enter = (value: unknown, depth: number): boolean => {
    budget.nodes += 1;
    if (budget.nodes > budget.maxNodes) return false;
    const kind = kindOf(value);
    if (kind == null) return false;
    if (kind === "array" || kind === "object") {
      if (depth >= limits.maxDepth) return false;
      stack.push(
        kind === "array"
          ? { kind, value: value as unknown[], index: 0, depth }
          : {
              kind,
              value: value as Record<string, unknown>,
              keys: ownKeys(value as Record<string, unknown>),
              depth,
            },
      );
      return true;
    }
    if (kind === "string") {
      const length = (value as string).length;
      if (length > limits.maxStringLength) return false;
      budget.bytes += length;
    } else {
      budget.bytes += 8;
    }
    return budget.bytes <= budget.maxBytes;
  };
  if (!enter(root, 0)) return false;
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    let child: unknown;
    if (frame.kind === "array") {
      if (frame.index >= frame.value.length) {
        stack.pop();
        continue;
      }
      child = frame.value[frame.index];
      frame.index += 1;
    } else {
      const next = frame.keys.next();
      if (next.done) {
        stack.pop();
        continue;
      }
      const key = next.value;
      if (key.length > limits.maxKeyLength) return false;
      budget.bytes += key.length;
      if (budget.bytes > budget.maxBytes) return false;
      child = frame.value[key];
    }
    if (!enter(child, frame.depth + 1)) return false;
  }
  return true;
}

// Whether an object has more than `max` own keys, stopping after max + 1
// (the engine's for-in enumeration itself is linear in the width).
function hasMoreKeysThan(value: Record<string, unknown>, max: number): boolean {
  let count = 0;
  for (const key in value) {
    if (hasOwn(value, key) && ++count > max) return true;
  }
  return false;
}

// The report's metadata reduced to the host-owned keys with valid values.
// Anything that is not a plain object, or has too many keys, yields {}
// (nothing is merged). Otherwise the allow-listed keys are checked in their
// fixed order, each within its own share of the budgets and what the earlier
// keys left: the node budget counts every value read, kept or dropped, so the
// whole report costs at most maxNodes reads (plus one per key); the byte
// budget counts what is kept. A value that fails is dropped and counted, and
// the rest are still checked (cheaply, once the budgets are used up).
export function pickHostReportedMetadata(
  metadata: unknown,
): Record<string, unknown> {
  const limits = HOST_REPORT_METADATA_LIMITS;
  if (metadata === undefined) return {};
  if (!isPlainObject(metadata)) {
    countDrop("not_object");
    return {};
  }
  if (hasMoreKeysThan(metadata, limits.maxTopLevelKeys)) {
    countDrop("too_many_keys");
    return {};
  }
  for (const key of Object.keys(metadata)) {
    if (!hasOwn(HOST_REPORTED_METADATA, key)) countDrop("unknown_key");
  }
  const picked: Record<string, unknown> = {};
  // Work: every value read, kept or dropped (bounds the time spent on a
  // report). Accepted: what is kept (bounds what is stored).
  let workNodes = 0;
  let acceptedBytes = 0;
  for (const key of HOST_REPORTED_METADATA_KEYS) {
    if (!hasOwn(metadata, key)) continue;
    const value = metadata[key];
    if (value === undefined) continue;
    const kind = kindOf(value);
    if (
      kind == null ||
      (kind !== "null" && !HOST_REPORTED_METADATA[key].includes(kind))
    ) {
      countDrop("invalid_value", key);
      continue;
    }
    const budget: Budget = {
      nodes: 0,
      bytes: 0,
      maxNodes: Math.min(limits.maxNodesPerKey, limits.maxNodes - workNodes),
      maxBytes: Math.min(
        limits.maxBytesPerKey,
        limits.maxBytes - acceptedBytes,
      ),
    };
    const ok = withinBudget(value, budget);
    workNodes += Math.min(budget.nodes, budget.maxNodes);
    if (!ok) {
      countDrop(
        budget.nodes > budget.maxNodes || budget.bytes > budget.maxBytes
          ? "over_budget"
          : "invalid_value",
        key,
      );
      continue;
    }
    acceptedBytes += budget.bytes;
    picked[key] = value;
  }
  return picked;
}
