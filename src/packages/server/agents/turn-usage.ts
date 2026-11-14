/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Agent turn usage (util/ai/agent-turn-usage): what each turn of an account's
// agents used, kept in the account's home bay for usage by agent. Hosts report
// it (hosts.recordAgentTurnUsage); this module stores and ages it out.

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import getLogger from "@cocalc/backend/logger";
import {
  parseAgentTurnUsage,
  type AgentTurnUsage,
} from "@cocalc/util/ai/agent-turn-usage";

const logger = getLogger("server:agents:turn-usage");

/** Rows older than this are deleted. */
export const AGENT_TURN_USAGE_RETENTION_DAYS = 90;
const PRUNE_INTERVAL_MS = 60 * 60_000;

type Queryable = {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
};

let db: () => Queryable = () => getPool();

/** Tests only. */
export function setTurnUsageDbForTests(next?: () => Queryable) {
  db = next ?? (() => getPool());
  lastPrune = 0;
}

let lastPrune = 0;

async function pruneOld(now: number): Promise<void> {
  if (now - lastPrune < PRUNE_INTERVAL_MS) return;
  lastPrune = now;
  try {
    await db().query(
      `DELETE FROM agent_turn_usage
        WHERE ended_at < now() - make_interval(days => $1)`,
      [AGENT_TURN_USAGE_RETENTION_DAYS],
    );
  } catch (error) {
    logger.debug("could not prune agent turn usage", { error: `${error}` });
  }
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
  for (const { usage: raw, host_id } of rows) {
    // Revalidated here too: never store what a remote bay passed on as is.
    const usage = parseAgentTurnUsage(raw);
    if (!usage) continue;
    const sum = totals(usage);
    await db().query(
      `INSERT INTO agent_turn_usage
         (account_id, id, project_id, path, thread_id, provider, payment,
          credential_id, pool, models, input_tokens, cached_input_tokens,
          cache_write_tokens, output_tokens, outcome, started_at, ended_at,
          host_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,
               to_timestamp($16::double precision / 1000),
               to_timestamp($17::double precision / 1000),$18)`,
      [
        account_id,
        randomUUID(),
        usage.project_id,
        usage.path,
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
    stored += 1;
  }
  await pruneOld(now);
  return stored;
}
