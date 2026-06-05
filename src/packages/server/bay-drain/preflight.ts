/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import {
  POSTGRES_TABLE_OWNERSHIP,
  type TableOwnershipEntry,
} from "@cocalc/util/db-schema";

export type BayDrainPreflightSeverity = "ok" | "warn" | "block";

export interface BayDrainPreflightFinding {
  table: string;
  severity: BayDrainPreflightSeverity;
  ownership?: TableOwnershipEntry["ownership"];
  portability?: TableOwnershipEntry["portability"];
  estimated_rows?: number | null;
  reason: string;
}

export interface BayDrainPreflightTableStats {
  table: string;
  estimated_rows?: number | null;
}

export interface BayDrainPreflightOptions {
  source_bay_id: string;
  seed_bay_id: string;
  unsafe_rehome?: boolean;
  tables?: Array<string | BayDrainPreflightTableStats>;
}

export interface BayDrainPreflightResult {
  source_bay_id: string;
  seed_bay_id: string;
  unsafe_rehome: boolean;
  ok: boolean;
  summary: {
    ok: number;
    warn: number;
    block: number;
    tables: number;
  };
  findings: BayDrainPreflightFinding[];
}

const DROP_SAFE_CLASSES = new Set<TableOwnershipEntry["ownership"]>([
  "cache",
  "ephemeral",
  "projection",
]);

function finding({
  table,
  entry,
  severity,
  estimated_rows,
  reason,
}: {
  table: string;
  entry?: TableOwnershipEntry;
  severity: BayDrainPreflightSeverity;
  estimated_rows?: number | null;
  reason: string;
}): BayDrainPreflightFinding {
  return {
    table,
    severity,
    ownership: entry?.ownership,
    portability: entry?.portability,
    estimated_rows,
    reason,
  };
}

export function evaluateBayDrainTable({
  table,
  source_bay_id,
  seed_bay_id,
  unsafe_rehome = false,
  estimated_rows,
}: BayDrainPreflightOptions & {
  table: string;
  estimated_rows?: number | null;
}): BayDrainPreflightFinding {
  const entry = POSTGRES_TABLE_OWNERSHIP[table];
  if (entry == null) {
    return finding({
      table,
      severity: "block",
      estimated_rows,
      reason:
        "table is not in the multibay ownership manifest; classify it before draining this bay",
    });
  }
  if (entry.ownership === "seed-global") {
    if (source_bay_id !== seed_bay_id) {
      return finding({
        table,
        entry,
        severity: "warn",
        estimated_rows,
        reason:
          "seed-global table exists on a non-seed bay; it should be a mirror/cache or be reconciled from seed before bay deletion",
      });
    }
    return finding({
      table,
      entry,
      severity: "ok",
      estimated_rows,
      reason: "seed bay owns this seed-global table",
    });
  }
  if (DROP_SAFE_CLASSES.has(entry.ownership)) {
    return finding({
      table,
      entry,
      severity: "ok",
      estimated_rows,
      reason: `${entry.ownership} state is documented as disposable or rebuildable`,
    });
  }
  if (entry.ownership === "audit-local") {
    return finding({
      table,
      entry,
      severity: "warn",
      estimated_rows,
      reason:
        "local audit history remains on this bay; export it if operational/legal retention requires it",
    });
  }
  if (entry.portability === "portable" || entry.portability === "rebuildable") {
    return finding({
      table,
      entry,
      severity: "ok",
      estimated_rows,
      reason: `${entry.ownership} state is ${entry.portability}`,
    });
  }
  if (unsafe_rehome) {
    return finding({
      table,
      entry,
      severity: "warn",
      estimated_rows,
      reason: `${entry.ownership} state is ${entry.portability}; continuing only because unsafe_rehome is set`,
    });
  }
  return finding({
    table,
    entry,
    severity: "block",
    estimated_rows,
    reason: `${entry.ownership} state is ${entry.portability}; pass an explicit unsafe override only after auditing rows on this bay`,
  });
}

function normalizeTableStats(
  table: string | BayDrainPreflightTableStats,
): BayDrainPreflightTableStats {
  return typeof table === "string" ? { table } : table;
}

export function evaluateBayDrainPreflight({
  source_bay_id,
  seed_bay_id,
  unsafe_rehome = false,
  tables = Object.keys(POSTGRES_TABLE_OWNERSHIP),
}: BayDrainPreflightOptions): BayDrainPreflightResult {
  const tableStats = new Map<string, BayDrainPreflightTableStats>();
  for (const table of tables) {
    const stats = normalizeTableStats(table);
    tableStats.set(stats.table, stats);
  }
  const findings = [...tableStats.values()]
    .sort((a, b) => a.table.localeCompare(b.table))
    .map((stats) =>
      evaluateBayDrainTable({
        table: stats.table,
        estimated_rows: stats.estimated_rows,
        source_bay_id,
        seed_bay_id,
        unsafe_rehome,
      }),
    );
  const summary = findings.reduce(
    (counts, item) => {
      counts[item.severity] += 1;
      return counts;
    },
    { ok: 0, warn: 0, block: 0, tables: findings.length },
  );
  return {
    source_bay_id,
    seed_bay_id,
    unsafe_rehome,
    ok: summary.block === 0,
    summary,
    findings,
  };
}

export async function listLocalPostgresTableStats(): Promise<
  BayDrainPreflightTableStats[]
> {
  const { rows } = await getPool("medium").query<{
    table_name: string;
    estimated_rows: number | string | null;
  }>(
    `
      SELECT c.relname AS table_name,
             GREATEST(c.reltuples, 0)::BIGINT AS estimated_rows
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind = 'r'
       ORDER BY c.relname
    `,
  );
  return rows.map((row) => ({
    table: row.table_name,
    estimated_rows:
      row.estimated_rows == null ? null : Number(row.estimated_rows),
  }));
}

export async function listLocalPostgresTables(): Promise<string[]> {
  return (await listLocalPostgresTableStats()).map((row) => row.table);
}

export async function runBayDrainPreflight(
  opts: Omit<BayDrainPreflightOptions, "tables">,
): Promise<BayDrainPreflightResult> {
  return evaluateBayDrainPreflight({
    ...opts,
    tables: await listLocalPostgresTableStats(),
  });
}
