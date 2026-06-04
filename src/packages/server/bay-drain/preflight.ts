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
  reason: string;
}

export interface BayDrainPreflightOptions {
  source_bay_id: string;
  seed_bay_id: string;
  unsafe_rehome?: boolean;
  tables?: string[];
}

export interface BayDrainPreflightResult {
  source_bay_id: string;
  seed_bay_id: string;
  unsafe_rehome: boolean;
  ok: boolean;
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
  reason,
}: {
  table: string;
  entry?: TableOwnershipEntry;
  severity: BayDrainPreflightSeverity;
  reason: string;
}): BayDrainPreflightFinding {
  return {
    table,
    severity,
    ownership: entry?.ownership,
    portability: entry?.portability,
    reason,
  };
}

export function evaluateBayDrainTable({
  table,
  source_bay_id,
  seed_bay_id,
  unsafe_rehome = false,
}: BayDrainPreflightOptions & { table: string }): BayDrainPreflightFinding {
  const entry = POSTGRES_TABLE_OWNERSHIP[table];
  if (entry == null) {
    return finding({
      table,
      severity: "block",
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
        reason:
          "seed-global table exists on a non-seed bay; it should be a mirror/cache or be reconciled from seed before bay deletion",
      });
    }
    return finding({
      table,
      entry,
      severity: "ok",
      reason: "seed bay owns this seed-global table",
    });
  }
  if (DROP_SAFE_CLASSES.has(entry.ownership)) {
    return finding({
      table,
      entry,
      severity: "ok",
      reason: `${entry.ownership} state is documented as disposable or rebuildable`,
    });
  }
  if (entry.ownership === "audit-local") {
    return finding({
      table,
      entry,
      severity: "warn",
      reason:
        "local audit history remains on this bay; export it if operational/legal retention requires it",
    });
  }
  if (entry.portability === "portable" || entry.portability === "rebuildable") {
    return finding({
      table,
      entry,
      severity: "ok",
      reason: `${entry.ownership} state is ${entry.portability}`,
    });
  }
  if (unsafe_rehome) {
    return finding({
      table,
      entry,
      severity: "warn",
      reason: `${entry.ownership} state is ${entry.portability}; continuing only because unsafe_rehome is set`,
    });
  }
  return finding({
    table,
    entry,
    severity: "block",
    reason: `${entry.ownership} state is ${entry.portability}; pass an explicit unsafe override only after auditing rows on this bay`,
  });
}

export function evaluateBayDrainPreflight({
  source_bay_id,
  seed_bay_id,
  unsafe_rehome = false,
  tables = Object.keys(POSTGRES_TABLE_OWNERSHIP),
}: BayDrainPreflightOptions): BayDrainPreflightResult {
  const findings = [...new Set(tables)].sort().map((table) =>
    evaluateBayDrainTable({
      table,
      source_bay_id,
      seed_bay_id,
      unsafe_rehome,
    }),
  );
  return {
    source_bay_id,
    seed_bay_id,
    unsafe_rehome,
    ok: !findings.some((item) => item.severity === "block"),
    findings,
  };
}

export async function listLocalPostgresTables(): Promise<string[]> {
  const { rows } = await getPool("medium").query<{ table_name: string }>(
    `
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_type = 'BASE TABLE'
       ORDER BY table_name
    `,
  );
  return rows.map((row) => row.table_name);
}

export async function runBayDrainPreflight(
  opts: Omit<BayDrainPreflightOptions, "tables">,
): Promise<BayDrainPreflightResult> {
  return evaluateBayDrainPreflight({
    ...opts,
    tables: await listLocalPostgresTables(),
  });
}
