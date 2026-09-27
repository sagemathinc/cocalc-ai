/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import getPool from "@cocalc/database/pool";
import type { CollaborationAccessGrant } from "@cocalc/conat/inter-bay/collaborators";
import { ACCESS_LEASE_MS, transaction, uuid } from "./collaborators-common";
import { bumpCollaborationRevision } from "./collaborators-changes";
import {
  assertAccountNotRehoming,
  assertAccountWriteOnHomeBay,
} from "./account-rehome-fence";

export interface CollaborationAccessJob {
  account_id: string;
  project_id: string;
  grant_request_id: string;
}

export async function claimCollaborationAccess(
  bay_id: string,
): Promise<CollaborationAccessJob[]> {
  const { rows } = await getPool().query(
    `WITH due AS MATERIALIZED (
    SELECT x.account_id,x.project_id FROM collaboration_access x JOIN accounts a USING(account_id)
    WHERE x.lease_due_at<=now() AND (x.lease_claim_until IS NULL OR x.lease_claim_until<now())
    AND COALESCE(a.home_bay_id,'bay-0')=$1 AND NOT COALESCE(a.deleted,FALSE) AND NOT COALESCE(a.banned,FALSE)
    ORDER BY x.lease_due_at,x.account_id,x.project_id LIMIT 50 FOR UPDATE OF x SKIP LOCKED)
    UPDATE collaboration_access x SET grant_request_id=gen_random_uuid(),lease_claim_until=now()+interval '20 seconds'
    FROM due WHERE x.account_id=due.account_id AND x.project_id=due.project_id
    RETURNING x.account_id,x.project_id,x.grant_request_id`,
    [bay_id],
  );
  return rows;
}

/** Membership only: one locked project read for the entire owner-bay batch. */
export async function readCollaborationAccess(
  requests: { account_id: string; project_id: string }[],
  owning_bay_id: string,
): Promise<CollaborationAccessGrant[]> {
  if (!Array.isArray(requests) || requests.length > 50)
    throw Error("access batch limit exceeded");
  for (const r of requests) {
    uuid(r.account_id, "account_id");
    uuid(r.project_id, "project_id");
  }
  return transaction(async (db) => {
    const projects = [...new Set(requests.map((r) => r.project_id))].sort();
    await db.query(
      `SELECT pg_advisory_xact_lock(hashtext('project-rehome'),hashtext(id::text))
      FROM (SELECT unnest($1::uuid[]) AS id ORDER BY id) p`,
      [projects],
    );
    const tables = (
      await db.query(
        `SELECT to_regclass('public.project_rehome_operations') AS operations,
          to_regclass('public.project_collaboration_rehome_transfers') AS transfers`,
      )
    ).rows[0];
    const { rows } = await db.query(
      `SELECT project_id FROM projects p WHERE project_id=ANY($1::uuid[])
      AND owning_bay_id=$2 ${tables?.operations ? "AND NOT EXISTS(SELECT 1 FROM project_rehome_operations o WHERE o.project_id=p.project_id AND o.status='running')" : ""}
      ${
        tables?.transfers
          ? `AND NOT EXISTS(SELECT 1 FROM project_collaboration_rehome_transfers t WHERE t.project_id=p.project_id
        AND ((t.direction='export' AND t.state IN ('exporting','exported'))
          OR (t.direction='import' AND t.state IN ('staging','ready'))))`
          : ""
      }
      ORDER BY project_id FOR SHARE`,
      [projects, owning_bay_id],
    );
    await db.query(
      `INSERT INTO collaboration_projects(project_id,generation) SELECT id,gen_random_uuid() FROM unnest($1::uuid[]) AS p(id) ON CONFLICT DO NOTHING`,
      [rows.map((row) => row.project_id)],
    );
    return (
      await db.query(
        `SELECT r.account_id,r.project_id,
      CASE WHEN p.deleted IS NOT TRUE AND p.users #>> ARRAY[r.account_id::text,'group'] IN ('owner','collaborator') THEN s.generation END AS generation
      FROM jsonb_to_recordset($1::jsonb) AS r(account_id uuid,project_id uuid)
      LEFT JOIN projects p ON p.project_id=r.project_id AND p.project_id=ANY($2::uuid[])
      LEFT JOIN collaboration_projects s ON s.project_id=p.project_id`,
        [JSON.stringify(requests), rows.map((row) => row.project_id)],
      )
    ).rows;
  });
}

export async function applyCollaborationAccess(
  jobs: CollaborationAccessJob[],
  grants: CollaborationAccessGrant[],
  requested_at: number,
) {
  if (
    jobs.length > 50 ||
    grants.length !== jobs.length ||
    !Number.isFinite(requested_at) ||
    Date.now() - requested_at >= ACCESS_LEASE_MS ||
    requested_at > Date.now()
  )
    throw Error("invalid or expired access batch");
  const byKey = new Map(
    grants.map((g) => [`${g.account_id}/${g.project_id}`, g]),
  );
  const updates = jobs.map((job) => {
    const grant = byKey.get(`${job.account_id}/${job.project_id}`);
    if (!grant) throw Error("access grant mismatch");
    if (grant.generation !== null) uuid(grant.generation, "grant generation");
    return { ...job, generation: grant.generation };
  });
  return transaction(async (db) => {
    for (const account_id of [
      ...new Set(jobs.map((j) => j.account_id)),
    ].sort()) {
      await assertAccountNotRehoming({
        db,
        account_id,
        action: "refresh collaboration access",
      });
      await assertAccountWriteOnHomeBay({
        db,
        account_id,
        action: "refresh collaboration access",
      });
    }
    // A newer batch or projection claim invalidates this response. Lock in the
    // same order as projection writes; update all grants in one statement.
    const { rows } = await db.query(
      `WITH incoming AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS j(account_id uuid,project_id uuid,grant_request_id uuid,generation uuid)),
      locked AS MATERIALIZED (
      SELECT x.account_id,x.project_id,COALESCE(x.granted_generation,x.generation) AS old_generation,x.lease_until,
        CASE WHEN i.users_summary #>> ARRAY[x.account_id::text,'group'] IN ('owner','collaborator') THEN j.generation END AS generation
      FROM incoming j JOIN collaboration_access x USING(account_id,project_id,grant_request_id)
      LEFT JOIN account_project_index i USING(account_id,project_id)
      ORDER BY x.account_id,x.project_id FOR UPDATE OF x)
      UPDATE collaboration_access x SET granted_generation=l.generation,
      generation=CASE WHEN l.generation IS NULL THEN NULL ELSE x.generation END,
      revision=CASE WHEN l.generation IS NULL THEN 0 ELSE x.revision END,
      after_key=CASE WHEN l.generation IS NULL THEN '' ELSE x.after_key END,
      lease_until=CASE WHEN l.generation IS NULL THEN NULL ELSE $2::timestamp END,
      lease_due_at=now()+interval '20 seconds',lease_claim_until=NULL,
      complete=CASE WHEN l.old_generation IS DISTINCT FROM l.generation THEN FALSE ELSE x.complete END,
      due_at=CASE WHEN l.old_generation IS DISTINCT FROM l.generation THEN now() ELSE x.due_at END
      FROM locked l WHERE x.account_id=l.account_id AND x.project_id=l.project_id
      RETURNING x.account_id,(l.old_generation IS DISTINCT FROM l.generation OR l.lease_until IS NULL OR l.lease_until<=now()) AS changed`,
      [JSON.stringify(updates), new Date(requested_at + ACCESS_LEASE_MS)],
    );
    const changed = new Set<string>(
      rows.filter((row) => row.changed).map((row) => row.account_id),
    );
    for (const account_id of changed)
      await bumpCollaborationRevision(db, account_id);
    return rows.length;
  });
}

export async function failCollaborationAccess(jobs: CollaborationAccessJob[]) {
  await getPool().query(
    `UPDATE collaboration_access x SET lease_claim_until=NULL,lease_due_at=now()+interval '5 seconds'
    FROM jsonb_to_recordset($1::jsonb) AS j(account_id uuid,project_id uuid,grant_request_id uuid)
    WHERE x.account_id=j.account_id AND x.project_id=j.project_id AND x.grant_request_id=j.grant_request_id`,
    [JSON.stringify(jobs)],
  );
}
