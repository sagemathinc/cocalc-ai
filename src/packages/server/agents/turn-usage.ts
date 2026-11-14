/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Agent turn usage (util/ai/agent-turn-usage): what each turn of an account's
// agents used, kept in the account's home bay for usage by agent. Hosts report
// it (hosts.recordAgentTurnUsage); agent maintenance ages it out
// (maintenance.ts, by received_at).

import { createHash, randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import getLogger from "@cocalc/backend/logger";
import {
  parseAgentTurnUsage,
  type AgentTurnUsage,
} from "@cocalc/util/ai/agent-turn-usage";

const logger = getLogger("server:agents:turn-usage");


/**
 * At most this many turns from one host are stored per hour, per home bay:
 * far more than real use (a turn takes seconds to hours), but it bounds what a
 * misbehaving host can write. Reports over it are dropped.
 */
export const MAX_TURNS_PER_HOST_PER_HOUR = 2_000;

type Queryable = {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: any[]; rowCount?: number | null }>;
};

let db: () => Queryable = () => getPool();

/** Tests only. */
export function setTurnUsageDbForTests(next?: () => Queryable) {
  db = next ?? (() => getPool());
}

/** The chat path is stored only as this: it matches an agent's path without
 * keeping directory or file names. */
export function turnUsagePathHash(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}

function totals(usage: AgentTurnUsage) {
  const sum = { input: 0, cached: 0, write: 0, output: 0 };
  for (const m of usage.models) {
    sum.input += m.input_tokens;
    sum.cached += m.cached_input_tokens;
    sum.write += m.cache_write_tokens;
    sum.output += m.output_tokens;
  }
  return sum;
}

async function hostBudget(host_id: string | undefined): Promise<number> {
  if (!host_id) return MAX_TURNS_PER_HOST_PER_HOUR;
  const { rows } = await db().query(
    `SELECT count(*)::int AS n FROM agent_turn_usage
      WHERE host_id=$1 AND received_at > now() - interval '1 hour'`,
    [host_id],
  );
  return Math.max(0, MAX_TURNS_PER_HOST_PER_HOUR - (rows[0]?.n ?? 0));
}

/** Home-bay write. The caller has checked this is the account's home bay
 * and that the reporting host may report for it. Returns rows stored. */
export async function insertAgentTurnUsage({
  account_id,
  rows,
  now = Date.now(),
}: {
  account_id: string;
  rows: Array<{ usage: unknown; host_id?: string }>;
  now?: number;
}): Promise<number> {
  let stored = 0;
  const budgets = new Map<string, number>();
  for (const { usage: raw, host_id } of rows) {
    // Revalidated here too: never store what a remote bay passed on as is.
    const usage = parseAgentTurnUsage(raw, now);
    if (!usage) continue;
    const hostKey = host_id ?? "";
    if (!budgets.has(hostKey)) budgets.set(hostKey, await hostBudget(host_id));
    const budget = budgets.get(hostKey)!;
    if (budget <= 0) {
      logger.debug("agent turn usage over the host budget", { host_id });
      continue;
    }
    const sum = totals(usage);
    // One row that the database refuses must not lose the rest of the batch.
    try {
      const { rowCount } = await db().query(
        `INSERT INTO agent_turn_usage
         (account_id, id, project_id, path_hash, thread_id, provider, payment,
          credential_id, pool, models, input_tokens, cached_input_tokens,
          cache_write_tokens, output_tokens, outcome, started_at, ended_at,
          host_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,
               to_timestamp($16::double precision / 1000),
               to_timestamp($17::double precision / 1000),$18)
       ON CONFLICT (account_id, id) DO NOTHING`,
        [
          account_id,
          // A resent report (same turn) is stored once.
          usage.turn_id ?? randomUUID(),
          usage.project_id,
          turnUsagePathHash(usage.path),
          usage.thread_id,
          usage.provider,
          usage.payment,
          usage.credential_id ?? null,
          usage.pool ?? null,
          JSON.stringify(usage.models),
          sum.input,
          sum.cached,
          sum.write,
          sum.output,
          usage.outcome,
          usage.started_at,
          usage.ended_at,
          host_id ?? null,
        ],
      );
      if (rowCount) {
        stored += 1;
        budgets.set(hostKey, budget - 1);
      }
    } catch (error) {
      logger.debug("agent turn usage row not stored", { error: `${error}` });
    }
  }
  return stored;
}
