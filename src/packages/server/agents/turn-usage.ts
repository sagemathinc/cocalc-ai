/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Agent turn usage (util/ai/agent-turn-usage): what each turn of an account's
// agents used, kept in the account's home bay for usage by agent. Hosts report
// it (hosts.recordAgentTurnUsage); agent maintenance ages it out
// (maintenance.ts, by received_at).

import { createHash, randomUUID } from "node:crypto";
import getLogger from "@cocalc/backend/logger";
import {
  AGENT_USAGE_REPORT_MAX_HOURS,
  AGENT_USAGE_REPORT_MAX_ROWS,
  parseAgentTurnUsage,
  type AgentTurnUsage,
  type AgentUsageReport,
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

type Transaction = <T>(fn: (db: Queryable) => Promise<T>) => Promise<T>;

const defaultTransaction: Transaction = async (fn) => {
  const { agentStore } = await import("./store");
  return await agentStore().transaction(fn);
};

let transaction: Transaction = defaultTransaction;

/** Tests only. */
export function setTurnUsageTransactionForTests(next?: Transaction) {
  transaction = next ?? defaultTransaction;
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

/** Home-bay write. The caller has checked this is the account's home bay
 * and that the reporting host may report for it. Returns rows stored.
 *
 * Each host's turns are counted against its hourly budget and inserted in
 * one transaction under a host-scoped lock, so concurrent reports (parallel
 * RPC handlers, several hubs) cannot all spend the same allowance. */
export async function insertAgentTurnUsage({
  account_id,
  rows,
  now = Date.now(),
}: {
  account_id: string;
  rows: Array<{ usage: unknown; host_id?: string }>;
  now?: number;
}): Promise<number> {
  const byHost = new Map<string, AgentTurnUsage[]>();
  for (const { usage: raw, host_id } of rows) {
    // Revalidated here too: never store what a remote bay passed on as is.
    const usage = parseAgentTurnUsage(raw, now);
    if (!usage) continue;
    const list = byHost.get(host_id ?? "") ?? [];
    list.push(usage);
    byHost.set(host_id ?? "", list);
  }
  let stored = 0;
  for (const [hostKey, turns] of byHost) {
    const host_id = hostKey || undefined;
    try {
      stored += await transaction((db) =>
        insertHostTurns(db, account_id, host_id, turns),
      );
    } catch (error) {
      logger.debug("agent turn usage not stored", {
        host_id,
        error: `${error}`,
      });
    }
  }
  return stored;
}

async function insertHostTurns(
  db: Queryable,
  account_id: string,
  host_id: string | undefined,
  turns: AgentTurnUsage[],
): Promise<number> {
  let budget = MAX_TURNS_PER_HOST_PER_HOUR;
  if (host_id) {
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('agent-turn-usage-host:' || $1::text, 0))",
      [host_id],
    );
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM agent_turn_usage
        WHERE host_id=$1 AND received_at > now() - interval '1 hour'`,
      [host_id],
    );
    budget -= rows[0]?.n ?? 0;
  }
  let stored = 0;
  for (const usage of turns) {
    if (stored >= budget) {
      logger.debug("agent turn usage over the host budget", { host_id });
      break;
    }
    const sum = totals(usage);
    // One row that the database refuses must not lose the rest.
    await db.query("SAVEPOINT turn_usage_row");
    try {
      const { rowCount } = await db.query(
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
      await db.query("RELEASE SAVEPOINT turn_usage_row");
      if (rowCount) stored += 1;
    } catch (error) {
      await db.query("ROLLBACK TO SAVEPOINT turn_usage_row");
      logger.debug("agent turn usage row not stored", { error: `${error}` });
    }
  }
  return stored;
}

/** Token sums are reported as JSON numbers, so a sum is capped at the
 * largest integer a number holds exactly. The stored bounds (per field, per
 * turn, per host and hour) allow far larger sums than real use reaches; a
 * capped sum shows as at least this much rather than failing the report or
 * losing precision. */
export const AGENT_USAGE_REPORT_MAX_TOKENS = Number.MAX_SAFE_INTEGER;

function capped(field: string): string {
  return `LEAST(COALESCE(sum((m->>'${field}')::numeric), 0), ${AGENT_USAGE_REPORT_MAX_TOKENS})::bigint`;
}

/**
 * Home-bay read: this account's usage by agent conversation and model over
 * the last `hours`, busiest first, with the account's name for each agent
 * whose current conversation it is.
 */
export async function agentUsageReport({
  account_id,
  hours,
  now = Date.now(),
  query = (sql: string, values?: unknown[]) =>
    import("./store").then(({ agentStore }) => agentStore().query(sql, values)),
}: {
  account_id: string;
  hours: number;
  now?: number;
  query?: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>;
}): Promise<AgentUsageReport> {
  const period = Math.min(
    AGENT_USAGE_REPORT_MAX_HOURS,
    Math.max(1, Math.floor(Number(hours) || 24)),
  );
  const since = new Date(now - period * 3600_000);
  const { rows } = await query(
    `SELECT u.project_id, u.path_hash, u.thread_id, u.provider,
            COALESCE(m->>'model', 'unknown') AS model,
            count(DISTINCT u.id)::int AS turns,
            ${capped("input_tokens")} AS input_tokens,
            ${capped("cached_input_tokens")} AS cached_input_tokens,
            ${capped("cache_write_tokens")} AS cache_write_tokens,
            ${capped("output_tokens")} AS output_tokens,
            max(u.ended_at) AS last_at
       FROM agent_turn_usage u
       CROSS JOIN LATERAL jsonb_array_elements(u.models) AS m
      WHERE u.account_id=$1 AND u.ended_at > $2
      GROUP BY u.project_id, u.path_hash, u.thread_id, u.provider,
               COALESCE(m->>'model', 'unknown')
      ORDER BY sum((m->>'output_tokens')::numeric) DESC NULLS LAST
      LIMIT $3`,
    [account_id, since, AGENT_USAGE_REPORT_MAX_ROWS + 1],
  );
  const names = (
    await query(
      `SELECT name, project_id, metadata->>'path' AS path,
              metadata->>'thread_id' AS thread_id
         FROM agent_personal_names
        WHERE account_id=$1 AND retired_at IS NULL`,
      [account_id],
    )
  ).rows;
  // An agent is its (project, path, thread): a copied chat can keep the
  // thread id under another path, and that is another agent.
  const nameOf = new Map(
    names
      .filter((n) => n.path && n.thread_id)
      .map((n) => [
        `${n.project_id}/${turnUsagePathHash(n.path)}/${n.thread_id}`,
        n.name as string,
      ]),
  );
  const truncated = rows.length > AGENT_USAGE_REPORT_MAX_ROWS;
  return {
    since: since.toISOString(),
    hours: period,
    rows: rows.slice(0, AGENT_USAGE_REPORT_MAX_ROWS).map((r) => {
      const name = nameOf.get(`${r.project_id}/${r.path_hash}/${r.thread_id}`);
      return {
        project_id: r.project_id,
        path_hash: r.path_hash,
        thread_id: r.thread_id,
        provider: r.provider,
        model: r.model,
        ...(name ? { name } : {}),
        turns: Number(r.turns),
        input_tokens: Number(r.input_tokens),
        cached_input_tokens: Number(r.cached_input_tokens),
        cache_write_tokens: Number(r.cache_write_tokens),
        output_tokens: Number(r.output_tokens),
        last_at: new Date(r.last_at).toISOString(),
      };
    }),
    ...(truncated ? { truncated: true } : {}),
  };
}
