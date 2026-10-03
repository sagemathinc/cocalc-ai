/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Per-account abuse limits for agent memory. Charged only for operations an
// agent performs (never the owner's settings actions), inside the
// external-credential store functions, which run on the account's home bay.
// The counters are one Postgres row per account, updated atomically, so the
// limit is shared by every hub process in that bay and survives restarts.

import getPool from "@cocalc/database/pool";

export const AGENT_MEMORY_RATE_LIMITS = {
  readsPerMinute: 120,
  writesPerMinute: 30,
  writtenBytesPerHour: 4_000_000,
} as const;

export class AgentMemoryRateLimitError extends Error {}

type Counters = {
  minute_reads: number;
  minute_writes: number;
  hour_bytes: number | string;
};

export function agentMemoryLimitExceeded(row: Counters): string | undefined {
  if (row.minute_reads > AGENT_MEMORY_RATE_LIMITS.readsPerMinute)
    return "agent memory read rate limit reached; try again in a minute";
  if (row.minute_writes > AGENT_MEMORY_RATE_LIMITS.writesPerMinute)
    return "agent memory write rate limit reached; try again in a minute";
  if (Number(row.hour_bytes) > AGENT_MEMORY_RATE_LIMITS.writtenBytesPerHour)
    return "agent memory hourly write budget reached; try again later";
  return undefined;
}

// Atomically counts this operation, then rejects if the account is over its
// limit. Rejected attempts still count, so retries cannot bypass the limit.
export async function chargeAgentMemoryUsage(
  account_id: string,
  op: "read" | "write",
  payloadBytes = 0,
  query: (sql: string, params: unknown[]) => Promise<{ rows: Counters[] }> = (
    sql,
    params,
  ) => getPool().query(sql, params),
): Promise<void> {
  const reads = op === "read" ? 1 : 0;
  const writes = op === "write" ? 1 : 0;
  const bytes = op === "write" ? Math.max(0, Math.floor(payloadBytes)) : 0;
  const { rows } = await query(
    `INSERT INTO agent_memory_usage
       (account_id, minute_start, minute_reads, minute_writes, hour_start, hour_bytes)
     VALUES ($1, NOW(), $2, $3, NOW(), $4)
     ON CONFLICT (account_id) DO UPDATE SET
       minute_reads = CASE WHEN agent_memory_usage.minute_start > NOW() - INTERVAL '1 minute'
         THEN agent_memory_usage.minute_reads + $2 ELSE $2 END,
       minute_writes = CASE WHEN agent_memory_usage.minute_start > NOW() - INTERVAL '1 minute'
         THEN agent_memory_usage.minute_writes + $3 ELSE $3 END,
       minute_start = CASE WHEN agent_memory_usage.minute_start > NOW() - INTERVAL '1 minute'
         THEN agent_memory_usage.minute_start ELSE NOW() END,
       hour_bytes = CASE WHEN agent_memory_usage.hour_start > NOW() - INTERVAL '1 hour'
         THEN agent_memory_usage.hour_bytes + $4 ELSE $4 END,
       hour_start = CASE WHEN agent_memory_usage.hour_start > NOW() - INTERVAL '1 hour'
         THEN agent_memory_usage.hour_start ELSE NOW() END
     RETURNING minute_reads, minute_writes, hour_bytes`,
    [account_id, reads, writes, bytes],
  );
  const row = rows[0];
  if (!row)
    throw new AgentMemoryRateLimitError("agent memory usage unavailable");
  const exceeded = agentMemoryLimitExceeded(row);
  if (exceeded) throw new AgentMemoryRateLimitError(exceeded);
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

// Only server code sets this metadata, on behalf of an agent identity run;
// owner settings actions use "owner" and are never charged.
export function isAgentActor(
  metadata: Record<string, any> | undefined,
): boolean {
  return metadata?.actor === "agent";
}
