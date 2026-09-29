/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import { withAccountRehomeWriteFence } from "../account-rehome-fence";
import { uuid, boundedText, transaction } from "./collaborators-common";

import type {
  CollaborationDemandScope,
  CollaborationDemandState,
} from "@cocalc/util/collaboration-demand";
export type { CollaborationDemandScope } from "@cocalc/util/collaboration-demand";

export const DEMAND_LEASE_MS = 120_000;
export const DEMAND_RENEW_MS = 30_000;
export const DEMAND_GRACE_MS = 300_000;
export const DEMAND_CONSUMERS = 16;
// Separate churn bound: grace records must not consume ordinary live slots.
export const DEMAND_RETAINED_CONSUMERS = 256;

export function demandSchedulingEnabled() {
  return (
    process.env.COCALC_PEOPLE_DEMAND_SCHEDULER_PROTOTYPE === "1" &&
    process.env.COCALC_PEOPLE_DEMAND_PROTOTYPE === "1" &&
    process.env.COCALC_PEOPLE_EVENT_FANOUT_PROTOTYPE === "1"
  );
}

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
  await db.query(`ALTER TABLE collaboration_demand_activation
    ADD COLUMN IF NOT EXISTS projection_due TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS access_due TIMESTAMPTZ`);
  for (const field of ["projection_due", "access_due"])
    await db.query(`CREATE INDEX IF NOT EXISTS collaboration_demand_${field}
      ON collaboration_demand_activation(${field},account_id)`);
  await db.query(`CREATE TABLE IF NOT EXISTS collaboration_project_demand (
    account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    project_id UUID NOT NULL, grace_until TIMESTAMPTZ NOT NULL,
    PRIMARY KEY(account_id,project_id))`);
  await db.query(`CREATE INDEX IF NOT EXISTS collaboration_project_demand_active
    ON collaboration_project_demand(project_id,grace_until,account_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS collaboration_project_demand_expiry
    ON collaboration_project_demand(grace_until,account_id,project_id)`);
}

/** Refresh only for a claimed active job, in its home claiming transaction.
 * This reverse scheduling index grants no access and never creates demand.
 * Readers must recheck current home, demand scope and membership independently.
 */
export async function rememberCollaborationProjectDemand(
  db: Pick<PoolClient, "query">,
  account_id: string,
  project_id: string,
) {
  await db.query(
    `INSERT INTO collaboration_project_demand(account_id,project_id,grace_until)
     SELECT $1::uuid,$2::uuid,MAX(grace_until) FROM collaboration_demand
     WHERE account_id=$1 AND grace_until>now()
       AND (scope->>'kind'='all' OR scope->'project_ids' ? $2::uuid::text)
     HAVING MAX(grace_until) IS NOT NULL
     ON CONFLICT(account_id,project_id) DO UPDATE SET grace_until=excluded.grace_until`,
    [account_id, project_id],
  );
}

export interface ProjectDemandCursor {
  grace_until: string;
  account_id: string;
}

/** Scheduling candidates only. Renewals may move rows past the cursor, so
 * consumers must tolerate duplicates and restart after a completed traversal.
 */
export async function readCollaborationProjectDemandPage(opts: {
  project_id: string;
  home_bay_id: string;
  after?: ProjectDemandCursor;
  limit?: number;
}) {
  uuid(opts.project_id, "project demand project");
  boundedText(opts.home_bay_id, "project demand home", 128);
  if (opts.after) {
    uuid(opts.after.account_id, "project demand account cursor");
    boundedText(opts.after.grace_until, "project demand expiry cursor", 128);
  }
  const limit = opts.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20)
    throw Error("invalid project demand page limit");
  return transaction(async (db) => {
    await db.query("SET LOCAL statement_timeout='2s'");
    const { rows } = await db.query(
      `WITH candidates AS MATERIALIZED (
        SELECT account_id,grace_until FROM collaboration_project_demand
        WHERE project_id=$1 AND grace_until>now()
        ${opts.after ? "AND (grace_until,account_id)>($4::timestamptz,$5::uuid)" : ""}
        ORDER BY grace_until,account_id LIMIT $3)
      SELECT x.account_id,x.grace_until::text,
        (COALESCE(a.home_bay_id,'bay-0')=$2 AND a.deleted IS NOT TRUE AND a.banned IS NOT TRUE
        AND EXISTS(SELECT 1 FROM collaboration_demand d WHERE d.account_id=x.account_id
          AND d.grace_until>now() AND (d.scope->>'kind'='all' OR d.scope->'project_ids' ? $1::uuid::text))
        AND EXISTS(SELECT 1 FROM account_project_index p WHERE p.account_id=x.account_id AND p.project_id=$1
          AND p.users_summary #>> ARRAY[x.account_id::text,'group'] IN ('owner','collaborator'))) AS eligible
      FROM candidates x JOIN accounts a USING(account_id)
      ORDER BY x.grace_until,x.account_id`,
      opts.after
        ? [
            opts.project_id,
            opts.home_bay_id,
            limit,
            opts.after.grace_until,
            opts.after.account_id,
          ]
        : [opts.project_id, opts.home_bay_id, limit],
    );
    const last = rows.at(-1);
    return {
      examined: rows.length,
      account_ids: rows
        .filter((r) => r.eligible)
        .map((r) => r.account_id as string),
      next_after:
        rows.length === limit && last
          ? {
              grace_until: last.grace_until as string,
              account_id: last.account_id as string,
            }
          : null,
    };
  });
}

/** Called in the claiming transaction. A cold account is retired from this
 * queue once; selection starts with due account rows, not historical access rows.
 */
export async function claimDemandAccount(
  db: PoolClient,
  bay_id: string,
  kind: "projection" | "access",
) {
  return (await claimDemandAccounts(db, bay_id, kind, 1))[0];
}

export async function claimDemandAccounts(
  db: PoolClient,
  bay_id: string,
  kind: "projection" | "access",
  limit = 8,
): Promise<string[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 8)
    throw Error("invalid demand cohort limit");
  const field = kind === "projection" ? "projection_due" : "access_due";
  const { rows } = await db.query(
    `WITH candidate AS MATERIALIZED (
    SELECT q.account_id FROM collaboration_demand_activation q JOIN accounts a USING(account_id)
    WHERE q.${field}<=clock_timestamp() AND COALESCE(a.home_bay_id,'bay-0')=$1
    AND a.deleted IS NOT TRUE AND a.banned IS NOT TRUE
    ORDER BY q.${field},q.account_id LIMIT $2 FOR UPDATE OF q SKIP LOCKED),
    interest AS MATERIALIZED (SELECT c.account_id,EXISTS(SELECT 1 FROM collaboration_demand d
      WHERE d.account_id=c.account_id AND d.grace_until>clock_timestamp()) AS warm FROM candidate c)
    UPDATE collaboration_demand_activation q SET ${field}=CASE WHEN i.warm
      THEN clock_timestamp()+interval '1 second' ELSE NULL END FROM interest i
    WHERE q.account_id=i.account_id RETURNING q.account_id,i.warm`,
    [bay_id, limit],
  );
  return rows.filter((row) => row.warm).map((row) => row.account_id as string);
}

export const demandScopePredicate = `EXISTS(SELECT 1 FROM collaboration_demand d
  WHERE d.account_id=x.account_id AND d.grace_until>clock_timestamp()
  AND (d.scope->>'kind'='all' OR d.scope->'project_ids' ? x.project_id::text))`;

/** Run in the membership projection transaction, after its upsert. This is a
 * scheduling hint, not an access grant. Lock the account queue before access
 * rows, matching activation/claim lock order.
 */
export async function scheduleCollaborationMembershipDemand(
  db: Pick<PoolClient, "query">,
  account_id: string,
  project_id: string,
) {
  if (!demandSchedulingEnabled()) return;
  const { rows } = await db.query(
    `INSERT INTO collaboration_demand_activation(account_id,projection_due,access_due)
    SELECT p.account_id,clock_timestamp(),clock_timestamp()
    FROM account_project_index p JOIN accounts a USING(account_id)
    WHERE p.account_id=$1 AND p.project_id=$2
      AND a.deleted IS NOT TRUE AND a.banned IS NOT TRUE
      AND p.users_summary #>> ARRAY[p.account_id::text,'group'] IN ('owner','collaborator')
      AND EXISTS(SELECT 1 FROM collaboration_demand d WHERE d.account_id=p.account_id
        AND d.grace_until>clock_timestamp()
        AND (d.scope->>'kind'='all' OR d.scope->'project_ids' ? p.project_id::text))
    ON CONFLICT(account_id) DO UPDATE SET
      projection_due=LEAST(collaboration_demand_activation.projection_due,excluded.projection_due),
      access_due=LEAST(collaboration_demand_activation.access_due,excluded.access_due)
    RETURNING account_id`,
    [account_id, project_id],
  );
  if (!rows.length) return;
  await db.query(
    `INSERT INTO collaboration_access(account_id,project_id,due_at,lease_due_at)
    VALUES($1,$2,clock_timestamp(),clock_timestamp())
    ON CONFLICT(account_id,project_id) DO UPDATE SET
      due_at=LEAST(collaboration_access.due_at,excluded.due_at),
      lease_due_at=LEAST(collaboration_access.lease_due_at,excluded.lease_due_at)`,
    [account_id, project_id],
  );
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
    const live = rows.filter(
      (row) => !row.released && new Date(row.expires_at).getTime() > now,
    ).length;
    // Reacquiring an expired/released ID is a new live admission too.
    if (live >= DEMAND_CONSUMERS)
      throw Error("demand live consumer capacity reached");
    // Preserve promised grace rather than evicting scopes under churn pressure.
    if (!prior && rows.length >= DEMAND_RETAINED_CONSUMERS)
      throw Error(
        "demand retained consumer capacity reached; reuse a consumer or wait for grace expiry",
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
    if (page.length)
      await db.query(
        `UPDATE collaboration_demand_activation SET
      projection_due=LEAST(projection_due,clock_timestamp()),
      access_due=LEAST(access_due,clock_timestamp()) WHERE account_id=$1`,
        [account_id],
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

/** Remaining project-specific scheduling horizon, not an access grant. */
export async function inspectCollaborationProjectDemand(
  account_id: string,
  project_id: string,
): Promise<{ remaining_ms: number }> {
  uuid(project_id, "project_id");
  return onHome(account_id, async (db, now) => {
    const { rows } = await db.query(
      `SELECT MAX(grace_until) AS horizon FROM collaboration_demand
       WHERE account_id=$1 AND grace_until>$2
       AND (scope->>'kind'='all' OR scope->'project_ids' ? $3)`,
      [account_id, new Date(now), project_id.toLowerCase()],
    );
    return {
      remaining_ms: rows[0].horizon
        ? Math.max(0, rows[0].horizon.getTime() - now)
        : 0,
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
