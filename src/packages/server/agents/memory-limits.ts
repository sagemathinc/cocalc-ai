/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Per-account abuse limits for agent memory. They are checked in the
// external-credential store functions, which always run on the record's home
// bay, so they hold across every host, project and bay that routes there.

export const AGENT_MEMORY_RATE_LIMITS = {
  readsPerMinute: 120,
  writesPerMinute: 30,
  writtenBytesPerHour: 4_000_000,
} as const;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// Bound the limiter's own memory.
const MAX_TRACKED_ACCOUNTS = 50_000;

type Usage = { reads: number[]; writes: number[]; bytes: [number, number][] };
const usage = new Map<string, Usage>();

function prune(entry: Usage, now: number) {
  entry.reads = entry.reads.filter((t) => now - t < MINUTE);
  entry.writes = entry.writes.filter((t) => now - t < MINUTE);
  entry.bytes = entry.bytes.filter(([t]) => now - t < HOUR);
}

function usageFor(account_id: string, now: number): Usage {
  let entry = usage.get(account_id);
  if (!entry) {
    if (usage.size >= MAX_TRACKED_ACCOUNTS) {
      for (const [key, value] of usage) {
        prune(value, now);
        if (!value.reads.length && !value.writes.length && !value.bytes.length)
          usage.delete(key);
        if (usage.size < MAX_TRACKED_ACCOUNTS) break;
      }
    }
    entry = { reads: [], writes: [], bytes: [] };
    usage.set(account_id, entry);
  } else {
    // Refresh recency for the bounded map.
    usage.delete(account_id);
    usage.set(account_id, entry);
  }
  prune(entry, now);
  return entry;
}

export class AgentMemoryRateLimitError extends Error {}

export function checkAgentMemoryAccess(
  account_id: string,
  op: "read" | "write",
  payloadBytes = 0,
  now = Date.now(),
): void {
  const entry = usageFor(account_id, now);
  if (op === "read") {
    if (entry.reads.length >= AGENT_MEMORY_RATE_LIMITS.readsPerMinute)
      throw new AgentMemoryRateLimitError(
        "agent memory read rate limit reached; try again in a minute",
      );
    entry.reads.push(now);
    return;
  }
  const written = entry.bytes.reduce((sum, [, n]) => sum + n, 0);
  if (entry.writes.length >= AGENT_MEMORY_RATE_LIMITS.writesPerMinute)
    throw new AgentMemoryRateLimitError(
      "agent memory write rate limit reached; try again in a minute",
    );
  if (written + payloadBytes > AGENT_MEMORY_RATE_LIMITS.writtenBytesPerHour)
    throw new AgentMemoryRateLimitError(
      "agent memory hourly write budget reached; try again later",
    );
  entry.writes.push(now);
  entry.bytes.push([now, payloadBytes]);
}

export function isAgentMemorySelector(selector: {
  provider?: string;
  kind?: string;
  scope?: string;
}): boolean {
  return (
    `${selector.provider}`.toLowerCase() === "cocalc" &&
    `${selector.kind}`.toLowerCase() === "agent-memory" &&
    `${selector.scope}`.toLowerCase() === "account"
  );
}

/** For tests. */
export function resetAgentMemoryLimits(): void {
  usage.clear();
}
