/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
Project rehome of project funding requests and approval routes
(PROJECT_FUNDING.md §4a): the old owner reads every row of the project; the
new owner merges them in one transaction.

- Approval rows merge field-wise by version (mergeProjectFundingRoute): the
  approval part from the higher version, the pod locator from the higher
  pods_version. Never a blind overwrite, and merging twice changes nothing.
- Request rows (no funder) keep whichever copy was updated last; a pending
  request that would make two pending for the project is superseded.

The merge runs under the project rehome fence and, in the same transaction,
removes this bay's import marker (project_rehome_imports): from then on the
approval state machine may write here (server/gpu/project-funding-routes.ts
refuses with 'rehoming' while the marker exists).
*/

import getPool, { type PoolClient } from "@cocalc/database/pool";
import { lockProjectRehomeFence } from "@cocalc/database/postgres/project-rehome-fence";
import {
  mergeProjectFundingRoute,
  PROJECT_FUNDING_LEASE_MS,
  type ProjectComputeApprovalPortableRow,
  type ProjectFundingRoute,
} from "@cocalc/util/gpu/project-funding";

type Db = Pick<PoolClient, "query">;

const COLUMNS = [
  "id",
  "kind",
  "project_id",
  "provider",
  "state",
  "approval_id",
  "operation_id",
  "terms_hash",
  "funder_account_id",
  "funder_bay_id",
  "layer_id",
  "version",
  "lease_expires_at",
  "ended_reason",
  "ended_at",
  "live_pods",
  "pods_version",
  "display",
  "actor_kind",
  "actor_account_id",
  "request_summary",
  "request_expires_at",
  "created",
  "updated",
] as const;

const TIMES = new Set([
  "lease_expires_at",
  "ended_at",
  "request_expires_at",
  "created",
  "updated",
]);

function iso(value: unknown): string | null {
  if (value == null) return null;
  return new Date(value as any).toISOString();
}

function portable(row: any): ProjectComputeApprovalPortableRow {
  const out: any = {};
  for (const c of COLUMNS) {
    out[c] = TIMES.has(c) ? iso(row[c]) : (row[c] ?? null);
  }
  return out;
}

export async function readProjectComputeApprovals(
  project_id: string,
  db: Db = getPool(),
): Promise<ProjectComputeApprovalPortableRow[]> {
  const { rows } = await db.query(
    `SELECT * FROM project_compute_approvals WHERE project_id = $1 ORDER BY created, id`,
    [project_id],
  );
  return rows.map(portable);
}

function toRoute(row: ProjectComputeApprovalPortableRow): ProjectFundingRoute {
  return {
    approval_id: row.approval_id!,
    state: row.state as ProjectFundingRoute["state"],
    version: row.version,
    layer_id: row.layer_id,
    lease_expires_at:
      row.lease_expires_at == null ? null : new Date(row.lease_expires_at),
    ended_reason: row.ended_reason,
    ended_at: row.ended_at == null ? null : new Date(row.ended_at),
    live_pods: row.live_pods,
    pods_version: row.pods_version,
    display: row.display,
  };
}

function fromRoute(
  base: ProjectComputeApprovalPortableRow,
  route: ProjectFundingRoute,
): ProjectComputeApprovalPortableRow {
  return {
    ...base,
    state: route.state,
    version: route.version,
    layer_id: route.layer_id,
    lease_expires_at: iso(route.lease_expires_at),
    ended_reason: route.ended_reason,
    ended_at: iso(route.ended_at),
    live_pods: route.live_pods,
    pods_version: route.pods_version,
    display: route.display,
  };
}

async function upsert(
  db: Db,
  row: ProjectComputeApprovalPortableRow,
): Promise<void> {
  const values = COLUMNS.map((c) => {
    const v = (row as any)[c];
    return c === "display" || c === "request_summary"
      ? v == null
        ? null
        : JSON.stringify(v)
      : v;
  });
  const placeholders = COLUMNS.map((_, i) => `$${i + 1}`).join(", ");
  const updates = COLUMNS.filter((c) => c !== "id")
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(", ");
  await db.query(
    `INSERT INTO project_compute_approvals (${COLUMNS.join(", ")})
     VALUES (${placeholders})
     ON CONFLICT (id) DO UPDATE SET ${updates}`,
    values,
  );
}

// The first accept of a rehome on its destination: the project's portable
// state is still to come.
export async function markProjectRehomeImport(
  db: Db,
  { project_id, source_bay_id }: { project_id: string; source_bay_id: string },
): Promise<void> {
  await lockProjectRehomeFence({ db, project_id });
  await db.query(
    `INSERT INTO project_rehome_imports (project_id, source_bay_id, started)
     VALUES ($1, $2, now())
     ON CONFLICT (project_id) DO UPDATE SET source_bay_id = EXCLUDED.source_bay_id`,
    [project_id, source_bay_id],
  );
}

// Merge the old owner's rows into this bay's and end the import, in one
// transaction. Returns how many rows changed.
export async function mergeProjectComputeApprovals({
  project_id,
  rows,
}: {
  project_id: string;
  rows: ProjectComputeApprovalPortableRow[] | undefined;
}): Promise<number> {
  const incoming = (rows ?? []).filter((r) => r?.project_id === project_id);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await lockProjectRehomeFence({ db: client, project_id });
    const { rows: existingRows } = await client.query(
      `SELECT * FROM project_compute_approvals WHERE project_id = $1 ORDER BY id FOR UPDATE`,
      [project_id],
    );
    const existing = existingRows.map(portable);
    const byApproval = new Map(
      existing
        .filter((r) => r.kind === "approval")
        .map((r) => [r.approval_id, r]),
    );
    const byId = new Map(existing.map((r) => [r.id, r]));
    let changed = 0;
    // A pending slot gets a fresh lease here: the rehome may have taken
    // longer than what was left of it, and the funder's bay is still to
    // activate it (it now resolves this bay).
    const lease = new Date(Date.now() + PROJECT_FUNDING_LEASE_MS).toISOString();
    // approvals first, so a superseded request never blocks one
    for (const row of incoming.filter((r) => r.kind === "approval")) {
      const mine = byApproval.get(row.approval_id);
      let merged = mine
        ? fromRoute(mine, mergeProjectFundingRoute(toRoute(mine), toRoute(row)))
        : row;
      if (
        merged.state === "pending" &&
        (merged.lease_expires_at == null || merged.lease_expires_at < lease)
      ) {
        merged = { ...merged, lease_expires_at: lease };
      }
      if (mine && JSON.stringify(merged) === JSON.stringify(mine)) continue;
      await upsert(client, merged);
      changed += 1;
    }
    for (const row of incoming.filter((r) => r.kind === "request")) {
      const mine = byId.get(row.id);
      if (mine && new Date(mine.updated) >= new Date(row.updated)) continue;
      let next = row;
      if (next.state === "pending") {
        const other = existing.find(
          (r) =>
            r.kind === "request" &&
            r.state === "pending" &&
            r.provider === next.provider &&
            r.id !== next.id,
        );
        if (other) {
          // keep the newer pending request
          if (new Date(other.updated) >= new Date(next.updated)) {
            next = { ...next, state: "superseded" };
          } else {
            await upsert(client, { ...other, state: "superseded" });
          }
        }
      }
      await upsert(client, next);
      changed += 1;
    }
    await client.query(
      "DELETE FROM project_rehome_imports WHERE project_id = $1",
      [project_id],
    );
    await client.query("COMMIT");
    return changed;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
