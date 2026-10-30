/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
Project funding approvals on the project's owning bay (P): the slot H holds
before creating an approval's budget layer, the versioned messages that move
its routing record, and the lease that ends a slot H never activated
(PROJECT_FUNDING.md §4).

Every write here is behind the project rehome write fence: it refuses with a
retryable 'rehoming' while a rehome of the project runs on this bay, while
this bay owns the project but hasn't merged its portable state yet (the
import marker, project_rehome_imports), and when this bay no longer owns the
project. Callers (H) re-resolve the owner and retry; 'rehoming' is never an
answer about the approval itself.

Calls from another bay carry source_bay_id (bound to the authenticated bay
by the typed inter-bay service); it must be the funder's current home.
*/

import { randomUUID } from "node:crypto";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import { assertProjectNotRehoming } from "@cocalc/database/postgres/project-rehome-fence";
import { isValidUUID } from "@cocalc/util/misc";
import {
  applyProjectFundingMessage,
  PROJECT_FUNDING_LEASE_MS,
  PROJECT_FUNDING_PROVIDERS,
  type ProjectFundingDeliverRequest,
  type ProjectFundingDeliverResult,
  type ProjectFundingReserveRequest,
  type ProjectFundingReserveResult,
  type ProjectFundingRoute,
  type ProjectFundingStatusRequest,
  type ProjectFundingStatusResult,
} from "@cocalc/util/gpu/project-funding";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";

type Db = Pick<PoolClient, "query">;

const REHOMING = { status: "rehoming" } as const;
type Rehoming = typeof REHOMING;

export interface ProjectFundingRouteDeps {
  // for tests: the funder's current home bay
  accountHomeBay?: (account_id: string) => Promise<string>;
  now?: () => Date;
}

class RouteRehoming extends Error {
  constructor() {
    super("project rehoming");
  }
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== "string" || !isValidUUID(value)) {
    throw Error(`${label} must be a UUID.`);
  }
  return value;
}

async function accountHomeBay(account_id: string): Promise<string> {
  const { home_bay_id } = await resolveAccountHomeBay({
    account_id,
    user_account_id: account_id,
  });
  return `${home_bay_id ?? ""}`.trim() || getConfiguredBayId();
}

// A call about a funder's approval must come from that funder's home bay
// (or this bay itself, in process). source_bay_id is authenticated by the
// typed inter-bay service, so only a bay can claim to be itself.
export async function assertSentByAccountHome(
  source_bay_id: unknown,
  account_id: string,
  deps: ProjectFundingRouteDeps = {},
): Promise<void> {
  if (typeof source_bay_id !== "string" || !source_bay_id) {
    throw Object.assign(Error("source_bay_id is required"), { code: 403 });
  }
  const home = await (deps.accountHomeBay ?? accountHomeBay)(account_id);
  if (home !== source_bay_id) {
    throw Object.assign(
      Error(
        `project funding calls for account ${account_id} must come from its home bay ${home}, not ${source_bay_id}`,
      ),
      { code: 403 },
    );
  }
}

interface ProjectHere {
  deleted: boolean;
  users: Record<string, { group?: string }> | null;
}

// Under the rehome write fence: the project, if this bay owns it and has
// its portable state. Throws RouteRehoming otherwise.
async function lockProjectHere(
  db: Db,
  project_id: string,
): Promise<ProjectHere | undefined> {
  try {
    await assertProjectNotRehoming({
      db,
      project_id,
      action: "change project funding",
    });
  } catch (err) {
    if (/project rehome/.test(`${err}`)) throw new RouteRehoming();
    throw err;
  }
  const { rows: imports } = await db.query(
    "SELECT 1 FROM project_rehome_imports WHERE project_id = $1",
    [project_id],
  );
  if (imports.length > 0) throw new RouteRehoming();
  const { rows } = await db.query(
    "SELECT owning_bay_id, deleted, users FROM projects WHERE project_id = $1",
    [project_id],
  );
  const p = rows[0];
  if (!p) return undefined;
  const owner = `${p.owning_bay_id ?? ""}`.trim() || getConfiguredBayId();
  if (owner !== getConfiguredBayId()) throw new RouteRehoming();
  return { deleted: !!p.deleted, users: p.users ?? null };
}

function isCollaborator(p: ProjectHere | undefined, account_id: string) {
  const group = p?.users?.[account_id]?.group;
  return !p?.deleted && (group === "owner" || group === "collaborator");
}

async function withRouteWrite<T>(
  project_id: string,
  fn: (db: PoolClient, project: ProjectHere | undefined) => Promise<T>,
): Promise<T | Rehoming> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const project = await lockProjectHere(client, project_id);
    const result = await fn(client, project);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err instanceof RouteRehoming) return REHOMING;
    throw err;
  } finally {
    client.release();
  }
}

function toRoute(row: any): ProjectFundingRoute {
  return {
    approval_id: row.approval_id,
    state: row.state,
    version: row.version,
    layer_id: row.layer_id ?? null,
    lease_expires_at:
      row.lease_expires_at == null ? null : new Date(row.lease_expires_at),
    ended_reason: row.ended_reason ?? null,
    ended_at: row.ended_at == null ? null : new Date(row.ended_at),
    live_pods: row.live_pods,
    pods_version: row.pods_version,
    display: row.display ?? null,
  };
}

async function storeRoute(db: Db, id: string, r: ProjectFundingRoute) {
  await db.query(
    `UPDATE project_compute_approvals
        SET state = $2, version = $3, layer_id = $4, lease_expires_at = $5,
            ended_reason = $6, ended_at = $7, live_pods = $8, pods_version = $9,
            display = $10, updated = now()
      WHERE id = $1`,
    [
      id,
      r.state,
      r.version,
      r.layer_id,
      r.lease_expires_at,
      r.ended_reason,
      r.ended_at,
      r.live_pods,
      r.pods_version,
      r.display == null ? null : JSON.stringify(r.display),
    ],
  );
}

// H holds the project's one approval slot before creating the layer.
export async function reserveProjectFundingSlotLocal(
  req: ProjectFundingReserveRequest,
  deps: ProjectFundingRouteDeps = {},
): Promise<ProjectFundingReserveResult> {
  const project_id = requireId(req?.project_id, "project_id");
  const approval_id = requireId(req.approval_id, "approval_id");
  const operation_id = requireId(req.operation_id, "operation_id");
  const funder = requireId(req.funder_account_id, "funder_account_id");
  if (!PROJECT_FUNDING_PROVIDERS.includes(req.provider)) {
    throw Error("unknown provider");
  }
  if (
    typeof req.terms_hash !== "string" ||
    !/^[0-9a-f]{64}$/.test(req.terms_hash)
  ) {
    throw Error("terms_hash must be a sha256 hex digest");
  }
  await assertSentByAccountHome(req.source_bay_id, funder, deps);
  const now = (deps.now ?? (() => new Date()))();
  return await withRouteWrite(project_id, async (db, project) => {
    if (!isCollaborator(project, funder)) {
      return { status: "not_collaborator" as const };
    }
    const { rows: same } = await db.query(
      `SELECT * FROM project_compute_approvals
        WHERE funder_account_id = $1 AND operation_id = $2`,
      [funder, operation_id],
    );
    if (same[0]) {
      const row = same[0];
      if (
        row.approval_id !== approval_id ||
        row.terms_hash !== req.terms_hash ||
        row.project_id !== project_id
      ) {
        throw Error(
          "This approval request was already used with different terms.",
        );
      }
      if (row.state !== "pending") {
        return {
          status: "taken" as const,
          message:
            row.state === "active"
              ? "This approval is already active."
              : "This approval ended.",
        };
      }
      return {
        status: "reserved" as const,
        lease_expires_at: new Date(row.lease_expires_at).toISOString(),
        version: row.version,
      };
    }
    const { rows: taken } = await db.query(
      `SELECT 1 FROM project_compute_approvals
        WHERE project_id = $1 AND provider = $2 AND kind = 'approval'
          AND state IN ('pending', 'active')`,
      [project_id, req.provider],
    );
    if (taken.length > 0) {
      return {
        status: "taken" as const,
        message:
          "GPU use in this project is already funded (or being approved) by a collaborator. It can be approved again after that approval ends.",
      };
    }
    const lease = new Date(now.getTime() + PROJECT_FUNDING_LEASE_MS);
    await db.query(
      `INSERT INTO project_compute_approvals
         (id, kind, project_id, provider, state, approval_id, operation_id, terms_hash,
          funder_account_id, funder_bay_id, version, lease_expires_at, display,
          actor_kind, actor_account_id, created, updated)
       VALUES ($1, 'approval', $2, $3, 'pending', $4, $5, $6, $7, $8, 1, $9, $10,
               'user', $7, now(), now())`,
      [
        randomUUID(),
        project_id,
        req.provider,
        approval_id,
        operation_id,
        req.terms_hash,
        funder,
        req.source_bay_id,
        lease,
        JSON.stringify(req.display ?? null),
      ],
    );
    return {
      status: "reserved" as const,
      lease_expires_at: lease.toISOString(),
      version: 1,
    };
  });
}

// One message from H, applied in order (applyProjectFundingMessage).
export async function deliverProjectFundingMessageLocal(
  req: ProjectFundingDeliverRequest,
  deps: ProjectFundingRouteDeps = {},
): Promise<ProjectFundingDeliverResult> {
  const project_id = requireId(req?.project_id, "project_id");
  const funder = requireId(req.funder_account_id, "funder_account_id");
  const approval_id = requireId(req.message?.approval_id, "approval_id");
  await assertSentByAccountHome(req.source_bay_id, funder, deps);
  const now = (deps.now ?? (() => new Date()))();
  return await withRouteWrite(project_id, async (db, project) => {
    const { rows } = await db.query(
      `SELECT * FROM project_compute_approvals
        WHERE approval_id = $1 AND project_id = $2 AND funder_account_id = $3
        FOR UPDATE`,
      [approval_id, project_id, funder],
    );
    const row = rows[0];
    if (!row) return { status: "unknown_approval" as const };
    // An activation needs the binding the slot was reserved with, now: the
    // project still here and the funder still a collaborator. Otherwise the
    // slot ends instead (and H revokes its layer).
    if (req.message.kind === "activate" && row.state === "pending") {
      const lost =
        project == null || project.deleted
          ? ("project_deleted" as const)
          : !isCollaborator(project, funder)
            ? ("funder_left_project" as const)
            : undefined;
      if (lost) {
        const ended = {
          ...toRoute(row),
          state: "ended" as const,
          version: row.version + 1,
          ended_reason: lost,
          ended_at: now,
          lease_expires_at: null,
        };
        await storeRoute(db, row.id, ended);
        return {
          status: "committed" as const,
          outcome: "applied" as const,
          state: ended.state,
          version: ended.version,
          pods_version: ended.pods_version,
          ended_reason: lost,
        };
      }
    }
    const t = applyProjectFundingMessage(toRoute(row), req.message, now);
    if (t.outcome !== "stale") {
      await storeRoute(db, row.id, t.route);
    }
    if (t.outcome === "applied" && req.message.kind === "activate") {
      // the request it answers (if any) is approved
      await db.query(
        `UPDATE project_compute_approvals SET state = 'approved', updated = now()
          WHERE project_id = $1 AND provider = $2 AND kind = 'request' AND state = 'pending'`,
        [project_id, row.provider],
      );
    }
    return {
      status: "committed" as const,
      outcome: t.outcome,
      state: t.route.state,
      version: t.route.version,
      pods_version: t.route.pods_version,
      ended_reason: t.route.ended_reason,
    };
  });
}

// The route's state, for H's reconciliation and the reaper's binding check.
export async function projectFundingStatusLocal(
  req: ProjectFundingStatusRequest,
  deps: ProjectFundingRouteDeps = {},
): Promise<ProjectFundingStatusResult> {
  const project_id = requireId(req?.project_id, "project_id");
  const funder = requireId(req.funder_account_id, "funder_account_id");
  const approval_id = requireId(req.approval_id, "approval_id");
  await assertSentByAccountHome(req.source_bay_id, funder, deps);
  // Read under the same fence, so an answer never comes from a bay that is
  // giving the project up, or hasn't received its rows yet.
  return await withRouteWrite(project_id, async (db, project) => {
    const { rows } = await db.query(
      `SELECT * FROM project_compute_approvals
        WHERE approval_id = $1 AND project_id = $2 AND funder_account_id = $3`,
      [approval_id, project_id, funder],
    );
    const project_deleted = project == null || project.deleted;
    if (!rows[0]) {
      return { status: "unknown_approval" as const, project_deleted };
    }
    return {
      status: "found" as const,
      state: rows[0].state,
      version: rows[0].version,
      ended_reason: rows[0].ended_reason ?? null,
      project_deleted,
      funder_is_collaborator: isCollaborator(project, funder),
    };
  });
}

// End pending slots whose lease ran out (H never activated them), and tell
// each funder's bay so it revokes the layer it may have made. Returns how
// many ended.
export async function expireProjectFundingLeases(
  deps: ProjectFundingRouteDeps = {},
): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const { rows } = await getPool().query(
    `SELECT project_id, approval_id FROM project_compute_approvals
      WHERE kind = 'approval' AND state = 'pending' AND lease_expires_at <= $1
      ORDER BY lease_expires_at LIMIT 100`,
    [now],
  );
  let ended = 0;
  for (const { project_id, approval_id } of rows) {
    const result = await withRouteWrite(project_id, async (db) => {
      const { rows: locked } = await db.query(
        `SELECT * FROM project_compute_approvals
          WHERE approval_id = $1 AND state = 'pending' AND lease_expires_at <= $2
          FOR UPDATE`,
        [approval_id, now],
      );
      const row = locked[0];
      if (!row) return false;
      const version = row.version + 1;
      await storeRoute(db, row.id, {
        ...toRoute(row),
        state: "ended",
        version,
        ended_reason: "lease_expired",
        ended_at: now,
        lease_expires_at: null,
      });
      await enqueueProjectFundingMessage(db, {
        approval_id,
        project_id,
        target: "funder",
        funder_account_id: row.funder_account_id,
        kind: "end",
        version,
        payload: { reason: "lease_expired" },
        now,
      });
      return true;
    });
    if (result === true) ended += 1;
  }
  return ended;
}

// Queue one message for the other bay, in the caller's transaction.
export async function enqueueProjectFundingMessage(
  db: Db,
  m: {
    approval_id: string;
    project_id: string;
    target: "project" | "funder";
    funder_account_id: string;
    kind: "activate" | "update" | "end" | "pods";
    version: number;
    payload: Record<string, unknown>;
    now?: Date;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO project_funding_outbox
       (id, approval_id, project_id, target, funder_account_id, kind, version,
        payload, attempts, next_attempt_at, created)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, now())
     ON CONFLICT DO NOTHING`,
    [
      randomUUID(),
      m.approval_id,
      m.project_id,
      m.target,
      m.funder_account_id,
      m.kind,
      m.version,
      JSON.stringify(m.payload),
      m.now ?? new Date(),
    ],
  );
}
