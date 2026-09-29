/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import { withAccountRehomeWriteFence } from "../account-rehome-fence";
import { uuid } from "./collaborators-common";

import type {
  CollaborationDemandScope,
  CollaborationDemandState,
} from "@cocalc/util/collaboration-demand";
export type { CollaborationDemandScope } from "@cocalc/util/collaboration-demand";

export const DEMAND_LEASE_MS = 120_000;
export const DEMAND_RENEW_MS = 30_000;
export const DEMAND_GRACE_MS = 300_000;
export const DEMAND_CONSUMERS = 16;

/** Prototype store: installation is explicit until offline delivery is decoupled. */
export async function syncCollaborationDemandSchema(
  db: Pick<PoolClient, "query">,
) {
  await db.query(`CREATE TABLE IF NOT EXISTS collaboration_demand (
    account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    consumer_id UUID NOT NULL, lease_id UUID NOT NULL, scope JSONB NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL, renew_after TIMESTAMPTZ NOT NULL,
    grace_until TIMESTAMPTZ NOT NULL, released BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY(account_id,consumer_id))`);
  await db.query(`CREATE INDEX IF NOT EXISTS collaboration_demand_expiry
    ON collaboration_demand(grace_until,account_id,consumer_id)`);
  await db.query(`CREATE TABLE IF NOT EXISTS collaboration_demand_activation (
    account_id UUID PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
    after_project UUID, due_at TIMESTAMPTZ)`);
  await db.query(`CREATE INDEX IF NOT EXISTS collaboration_demand_activation_due
    ON collaboration_demand_activation(due_at,account_id)`);
}

function scopeOf(value: CollaborationDemandScope): CollaborationDemandScope {
  if (value?.kind === "all") return { kind: "all" };
  if (
    value?.kind !== "projects" ||
    !Array.isArray(value.project_ids) ||
    !value.project_ids.length ||
    value.project_ids.length > 100
  )
    throw Error("invalid demand scope");
  for (const id of value.project_ids) uuid(id, "demand project");
  return {
    kind: "projects",
    project_ids: [
      ...new Set(value.project_ids.map((id) => id.toLowerCase())),
    ].sort(),
  };
}

/** account_id must be obtained from authenticated routing, never a public body. */
async function onHome<T>(
  account_id: string,
  fn: (db: PoolClient, now: number) => Promise<T>,
) {
  uuid(account_id, "demand account");
  account_id = account_id.toLowerCase();
  return withAccountRehomeWriteFence({
    account_id,
    action: "change People demand",
    fn: async (db) => {
      const account = await db.query(
        "SELECT banned FROM accounts WHERE account_id=$1",
        [account_id],
      );
      if (account.rows[0]?.banned) throw Error("demand account unavailable");
      // Sample after the account fence lock: queued requests cannot extend a lease
      // using transaction-start time. This lock also serializes quota admission.
      const { rows } = await db.query(
        "SELECT extract(epoch FROM clock_timestamp())*1000 AS now",
      );
      return fn(db, Number(rows[0].now));
    },
  });
}

function receipt(row: any) {
  return {
    consumer_id: row.consumer_id as string,
    lease_id: row.lease_id as string,
    scope: row.scope as CollaborationDemandScope,
    expires_at: new Date(row.expires_at).getTime(),
    renew_after: new Date(row.renew_after).getTime(),
  };
}

export async function acquireCollaborationDemand(opts: {
  account_id: string;
  consumer_id: string;
  scope: CollaborationDemandScope;
}) {
  uuid(opts.consumer_id, "demand consumer");
  const scope = scopeOf(opts.scope);
  return onHome(opts.account_id, async (db, now) => {
    await db.query(
      "DELETE FROM collaboration_demand WHERE account_id=$1 AND grace_until<=$2",
      [opts.account_id, new Date(now)],
    );
    const { rows } = await db.query(
      "SELECT * FROM collaboration_demand WHERE account_id=$1 ORDER BY consumer_id",
      [opts.account_id],
    );
    const prior = rows.find(
      (row) => row.consumer_id === opts.consumer_id.toLowerCase(),
    );
    if (
      prior &&
      !prior.released &&
      new Date(prior.expires_at).getTime() > now
    ) {
      if (JSON.stringify(scopeOf(prior.scope)) !== JSON.stringify(scope))
        throw Error("demand consumer scope conflict");
      // Recreate lost ephemeral activation state without restarting an existing
      // cursor on ordinary admission retries.
      await db.query(
        `INSERT INTO collaboration_demand_activation(account_id,due_at)
        VALUES($1,clock_timestamp()) ON CONFLICT DO NOTHING`,
        [opts.account_id],
      );
      return receipt(prior); // Retries neither renew nor consume another slot.
    }
    // Bound grace state as well as live tabs, even under rapid acquire/release.
    if (!prior && rows.length >= DEMAND_CONSUMERS)
      throw Error(
        "demand consumer capacity reached; reuse a consumer or wait for grace expiry",
      );
    const result = await db.query(
      `INSERT INTO collaboration_demand
      (account_id,consumer_id,lease_id,scope,expires_at,renew_after,grace_until)
      VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(account_id,consumer_id) DO UPDATE SET lease_id=excluded.lease_id,
      scope=excluded.scope,expires_at=excluded.expires_at,renew_after=excluded.renew_after,
      grace_until=excluded.grace_until,released=FALSE RETURNING *`,
      [
        opts.account_id,
        opts.consumer_id,
        randomUUID(),
        JSON.stringify(scope),
        new Date(now + DEMAND_LEASE_MS),
        new Date(now + DEMAND_RENEW_MS),
        new Date(now + DEMAND_LEASE_MS + DEMAND_GRACE_MS),
      ],
    );
    await db.query(
      `INSERT INTO collaboration_demand_activation(account_id,due_at)
      VALUES($1,clock_timestamp()) ON CONFLICT(account_id) DO UPDATE
      SET after_project=NULL,due_at=excluded.due_at`,
      [opts.account_id],
    );
    return receipt(result.rows[0]);
  });
}

/** A new consumer queues bounded catch-up, not a synchronous global fanout.
 * Account fencing serializes cursor updates with admission/release/rehome.
 * This schedules existing authorized memberships only; demand grants no access.
 */
export async function activateCollaborationDemand(
  account_id: string,
  limit = 100,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw Error("invalid demand activation page limit");
  return onHome(account_id, async (db, now) => {
    const queued = (
      await db.query(
        `SELECT after_project,due_at FROM collaboration_demand_activation
      WHERE account_id=$1 FOR UPDATE`,
        [account_id],
      )
    ).rows[0];
    if (!queued || queued.due_at === null)
      return { scheduled: 0, complete: true };
    if (new Date(queued.due_at).getTime() > now)
      return { scheduled: 0, complete: false };
    const scopes = (
      await db.query(
        `SELECT scope FROM collaboration_demand
      WHERE account_id=$1 AND grace_until>$2`,
        [account_id, new Date(now)],
      )
    ).rows;
    if (!scopes.length) {
      await db.query(
        "DELETE FROM collaboration_demand_activation WHERE account_id=$1",
        [account_id],
      );
      return { scheduled: 0, complete: true };
    }
    const all = scopes.some((row) => row.scope.kind === "all");
    const projects = [
      ...new Set(scopes.flatMap((row) => row.scope.project_ids ?? [])),
    ];
    const members = (
      await db.query(
        `SELECT project_id FROM account_project_index
      WHERE account_id=$1 AND project_id>$2::uuid
      AND ($3::boolean OR project_id=ANY($4::uuid[]))
      AND users_summary #>> ARRAY[$1::text,'group'] IN ('owner','collaborator')
      ORDER BY project_id LIMIT $5`,
        [
          account_id,
          queued.after_project ?? "00000000-0000-0000-0000-000000000000",
          all,
          projects,
          limit + 1,
        ],
      )
    ).rows;
    const page = members.slice(0, limit);
    await db.query(
      `INSERT INTO collaboration_access(account_id,project_id,due_at,lease_due_at)
      SELECT $1,id,$3,$3 FROM unnest($2::uuid[]) ids(id)
      ON CONFLICT(account_id,project_id) DO UPDATE SET
      due_at=LEAST(collaboration_access.due_at,excluded.due_at),
      lease_due_at=LEAST(collaboration_access.lease_due_at,excluded.lease_due_at)`,
      [account_id, page.map((row) => row.project_id), new Date(now)],
    );
    const complete = members.length <= limit;
    await db.query(
      `UPDATE collaboration_demand_activation SET after_project=COALESCE($2,after_project),
      due_at=$3 WHERE account_id=$1`,
      [
        account_id,
        page.at(-1)?.project_id ?? null,
        complete ? null : new Date(now + 100),
      ],
    );
    return { scheduled: page.length, complete };
  });
}

/** Dispatch only explicitly queued accounts. Dormant account/membership tables
 * are not swept to discover work. The home fence rechecks ownership per page.
 */
export async function runCollaborationDemandActivation(bay_id: string) {
  const { rows } = await getPool().query(
    `SELECT q.account_id
    FROM collaboration_demand_activation q JOIN accounts a USING(account_id)
    WHERE q.due_at<=clock_timestamp() AND COALESCE(a.home_bay_id,'bay-0')=$1
    AND a.deleted IS NOT TRUE AND a.banned IS NOT TRUE
    ORDER BY q.due_at,q.account_id LIMIT 8`,
    [bay_id],
  );
  let scheduled = 0;
  for (const row of rows)
    scheduled += (await activateCollaborationDemand(row.account_id)).scheduled;
  return { accounts: rows.length, scheduled };
}

export async function renewCollaborationDemand(opts: {
  account_id: string;
  consumer_id: string;
  lease_id: string;
}) {
  uuid(opts.consumer_id, "demand consumer");
  uuid(opts.lease_id, "demand lease");
  return onHome(opts.account_id, async (db, now) => {
    const { rows } = await db.query(
      `SELECT * FROM collaboration_demand
      WHERE account_id=$1 AND consumer_id=$2 AND lease_id=$3 AND NOT released AND expires_at>$4`,
      [opts.account_id, opts.consumer_id, opts.lease_id, new Date(now)],
    );
    if (!rows.length) throw Error("demand lease expired or superseded");
    if (new Date(rows[0].renew_after).getTime() > now)
      return { ...receipt(rows[0]), renewed: false };
    const result = await db.query(
      `UPDATE collaboration_demand SET expires_at=$4,renew_after=$5,grace_until=$6
      WHERE account_id=$1 AND consumer_id=$2 AND lease_id=$3 RETURNING *`,
      [
        opts.account_id,
        opts.consumer_id,
        opts.lease_id,
        new Date(now + DEMAND_LEASE_MS),
        new Date(now + DEMAND_RENEW_MS),
        new Date(now + DEMAND_LEASE_MS + DEMAND_GRACE_MS),
      ],
    );
    return { ...receipt(result.rows[0]), renewed: true };
  });
}

export async function releaseCollaborationDemand(opts: {
  account_id: string;
  consumer_id: string;
  lease_id: string;
}) {
  uuid(opts.consumer_id, "demand consumer");
  uuid(opts.lease_id, "demand lease");
  return onHome(opts.account_id, async (db, now) => {
    const result = await db.query(
      `UPDATE collaboration_demand SET released=TRUE,
      expires_at=LEAST(expires_at,$4),grace_until=LEAST(grace_until,$5)
      WHERE account_id=$1 AND consumer_id=$2 AND lease_id=$3 AND NOT released RETURNING consumer_id`,
      [
        opts.account_id,
        opts.consumer_id,
        opts.lease_id,
        new Date(now),
        new Date(now + DEMAND_GRACE_MS),
      ],
    );
    return { released: result.rows.length === 1 };
  });
}

/** Scheduling interest only. This must never grant metadata or content access. */
export async function inspectCollaborationDemand(
  account_id: string,
): Promise<CollaborationDemandState> {
  return onHome(account_id, async (db, now) => {
    const { rows } = await db.query(
      "SELECT * FROM collaboration_demand WHERE account_id=$1 AND grace_until>$2",
      [account_id, new Date(now)],
    );
    const active = rows.filter(
      (row) => !row.released && new Date(row.expires_at).getTime() > now,
    ).length;
    const scope: CollaborationDemandScope | null = !rows.length
      ? null
      : rows.some((row) => row.scope.kind === "all")
        ? { kind: "all" }
        : {
            kind: "projects",
            project_ids: [
              ...new Set<string>(rows.flatMap((row) => row.scope.project_ids)),
            ].sort(),
          };
    return {
      state: active ? "active" : rows.length ? "grace" : "cold",
      active_consumers: active,
      scope,
    };
  });
}

/** Expiry-indexed bounded cleanup, not a scan of historical accounts. */
export async function pruneCollaborationDemand() {
  const { rows } = await getPool().query(`WITH expired AS (
    SELECT account_id,consumer_id FROM collaboration_demand WHERE grace_until<=clock_timestamp()
    ORDER BY grace_until,account_id,consumer_id LIMIT 500 FOR UPDATE SKIP LOCKED)
    DELETE FROM collaboration_demand d USING expired e
    WHERE d.account_id=e.account_id AND d.consumer_id=e.consumer_id RETURNING d.consumer_id`);
  return rows.length;
}
