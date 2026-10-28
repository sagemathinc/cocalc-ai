/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
gpu.spend: what the pods on the owner's RunPod keys (current and earlier) cost,
grouped by beneficiary, agent, project or pod. It reads only the KEY layer's
reservations: a pod also has a row on every project/beneficiary/agent layer
that applies, so summing all rows would count it more than once.

- settled reservations: their spent_usd, by settled_at in the period. This is
  the number the budget's spent_usd totals, and it becomes RunPod's billed
  amount once billing is reconciled (5d-2), with no change here.
- live (active) reservations: CoCalc's estimate so far, computed exactly as
  settlement will (actualCost: cost per hour, or the reserved hourly rate,
  times time since running_since).
- quarantined reservations: held, neither spent nor live.

Runs on the owner's home bay, where the rows are.
*/

import getPool from "@cocalc/database/pool";
import { isValidUUID } from "@cocalc/util/misc";
import { moneyToDbString, toDecimal } from "@cocalc/util/money";
import {
  GPU_SPEND_GROUP_BY,
  type GpuSpendGroupBy,
  type GpuSpendResult,
  type GpuSpendRow,
} from "@cocalc/util/gpu/types";
import type { InterBayGpuApi } from "@cocalc/conat/inter-bay/api";
import { actualCost } from "@cocalc/server/gpu/budgets";
import { budgetHomeClient } from "@cocalc/server/gpu/budget-api";

const DAY_MS = 86_400_000;
export const SPEND_DEFAULT_DAYS = 30;
export const SPEND_MAX_DAYS = 400;
// groups returned; totals always cover every group
export const SPEND_MAX_ROWS = 500;

// the pod column each grouping reads (never from the caller)
const GROUP_COLUMN: Record<GpuSpendGroupBy, string> = {
  beneficiary: "p.beneficiary_account_id::text",
  agent: "COALESCE(p.agent_id, '')",
  project: "COALESCE(p.project_id::text, '')",
  pod: "p.id::text",
};

export interface GpuSpendDeps {
  // for tests
  now?: () => number;
  homeClient?: (account_id: string) => Promise<InterBayGpuApi | undefined>;
}

function requireAccount(account_id: unknown): string {
  if (typeof account_id !== "string" || !isValidUUID(account_id)) {
    throw Error("must be signed in");
  }
  return account_id;
}

function parseTime(value: unknown, name: string): number | undefined {
  if (value == null) return undefined;
  const t = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(t)) throw Error(`${name} must be an ISO time.`);
  return t;
}

export function spendWindow(
  opts: { since?: unknown; until?: unknown },
  now: number,
): { since: number; until: number } {
  const until = parseTime(opts.until, "until") ?? now;
  const since =
    parseTime(opts.since, "since") ?? until - SPEND_DEFAULT_DAYS * DAY_MS;
  if (since >= until) throw Error("since must be before until.");
  if (until - since > SPEND_MAX_DAYS * DAY_MS) {
    throw Error(`The period can be at most ${SPEND_MAX_DAYS} days.`);
  }
  return { since, until };
}

function requireGroupBy(group_by: unknown): GpuSpendGroupBy {
  const g = group_by ?? "beneficiary";
  if (!GPU_SPEND_GROUP_BY.includes(g as GpuSpendGroupBy)) {
    throw Error(`group_by must be one of ${GPU_SPEND_GROUP_BY.join(", ")}.`);
  }
  return g as GpuSpendGroupBy;
}

type Sums = {
  label?: string;
  spent: ReturnType<typeof toDecimal>;
  live: ReturnType<typeof toDecimal>;
  held: ReturnType<typeof toDecimal>;
  pods: Set<string>;
  live_pods: Set<string>;
};

export async function getGpuSpendLocal(
  opts: {
    account_id?: string;
    since?: unknown;
    until?: unknown;
    group_by?: unknown;
  },
  deps: GpuSpendDeps = {},
): Promise<GpuSpendResult> {
  const account_id = requireAccount(opts.account_id);
  const group_by = requireGroupBy(opts.group_by);
  const now = (deps.now ?? Date.now)();
  const { since, until } = spendWindow(opts, now);
  const column = GROUP_COLUMN[group_by];
  const db = getPool();
  const groups = new Map<string, Sums>();
  const group = (key: string): Sums => {
    let g = groups.get(key);
    if (g == null) {
      g = {
        spent: toDecimal(0),
        live: toDecimal(0),
        held: toDecimal(0),
        pods: new Set(),
        live_pods: new Set(),
      };
      groups.set(key, g);
    }
    return g;
  };

  // Settled in the period, summed in the database.
  const { rows: settled } = await db.query(
    `SELECT ${column} AS key, MAX(p.handle) AS handle,
            SUM(r.spent_usd) AS spent, array_agg(DISTINCT p.id::text) AS pods
       FROM gpu_pod_reservations r
       JOIN gpu_budget_layers l ON l.id = r.layer_id AND l.scope_kind = 'key'
       JOIN gpu_pods p ON p.id = r.pod_id
      WHERE l.key_owner_account_id = $1 AND r.state = 'settled'
        AND r.settled_at >= $2 AND r.settled_at < $3
      GROUP BY 1`,
    [account_id, new Date(since), new Date(until)],
  );
  for (const row of settled) {
    const g = group(row.key);
    g.spent = g.spent.plus(row.spent ?? 0);
    for (const id of row.pods ?? []) g.pods.add(id);
    if (group_by === "pod") g.label = row.handle;
  }

  // Open reservations count only for a period that reaches now.
  if (until >= now) {
    const { rows: open } = await db.query(
      `SELECT ${column} AS key, p.id::text AS pod_id, p.handle, p.cost_per_hr,
              p.running_since, r.state, r.reserved_usd, r.hourly_usd
         FROM gpu_pod_reservations r
         JOIN gpu_budget_layers l ON l.id = r.layer_id AND l.scope_kind = 'key'
         JOIN gpu_pods p ON p.id = r.pod_id
        WHERE l.key_owner_account_id = $1
          AND r.state IN ('active', 'quarantined')`,
      [account_id],
    );
    for (const row of open) {
      const g = group(row.key);
      g.pods.add(row.pod_id);
      if (group_by === "pod") g.label = row.handle;
      if (row.state === "quarantined") {
        g.held = g.held.plus(row.reserved_usd ?? 0);
        continue;
      }
      g.live_pods.add(row.pod_id);
      g.live = g.live.plus(
        actualCost({
          cost_per_hr: row.cost_per_hr,
          reserved_hourly_usd: row.hourly_usd,
          running_since: row.running_since,
          ended_at: new Date(now),
        }),
      );
    }
  }

  const all: (GpuSpendRow & { total: ReturnType<typeof toDecimal> })[] = [];
  const totals = {
    spent: toDecimal(0),
    live: toDecimal(0),
    held: toDecimal(0),
  };
  for (const [key, g] of groups) {
    totals.spent = totals.spent.plus(g.spent);
    totals.live = totals.live.plus(g.live);
    totals.held = totals.held.plus(g.held);
    all.push({
      key,
      ...(g.label != null ? { label: g.label } : {}),
      spent_usd: moneyToDbString(g.spent),
      live_estimate_usd: moneyToDbString(g.live),
      held_usd: moneyToDbString(g.held),
      pods: g.pods.size,
      pods_live: g.live_pods.size,
      total: g.spent.plus(g.live).plus(g.held),
    });
  }
  all.sort((a, b) => b.total.comparedTo(a.total) || a.key.localeCompare(b.key));
  return {
    as_of: new Date(now).toISOString(),
    since: new Date(since).toISOString(),
    until: new Date(until).toISOString(),
    group_by,
    rows: all.slice(0, SPEND_MAX_ROWS).map(({ total: _total, ...row }) => row),
    totals: {
      spent_usd: moneyToDbString(totals.spent),
      live_estimate_usd: moneyToDbString(totals.live),
      held_usd: moneyToDbString(totals.held),
    },
    ...(all.length > SPEND_MAX_ROWS ? { truncated: true } : {}),
  };
}

export async function getGpuSpend(
  opts: {
    account_id?: string;
    since?: unknown;
    until?: unknown;
    group_by?: unknown;
  },
  deps: GpuSpendDeps = {},
): Promise<GpuSpendResult> {
  const account_id = requireAccount(opts.account_id);
  const forwarded = {
    account_id,
    since: opts.since,
    until: opts.until,
    group_by: opts.group_by,
  };
  const home = await (deps.homeClient ?? budgetHomeClient)(account_id);
  if (home) return await home.gpuSpend(forwarded);
  return await getGpuSpendLocal(forwarded, deps);
}
