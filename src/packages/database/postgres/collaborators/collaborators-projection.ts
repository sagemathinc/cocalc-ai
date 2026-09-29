/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import {
  claimDemandAccount,
  claimDemandAccounts,
  demandSchedulingEnabled,
  demandScopePredicate,
} from "./collaborators-demand";
import {
  applyHomeParticipantProjection,
  sameParticipantContinuation,
} from "./collaborators-relations-projection";
import { moveCollaborationAgentPersonalState } from "./collaborators-agent-personal";
import {
  assertAccountNotRehoming,
  assertAccountWriteOnHomeBay,
} from "../account-rehome-fence";
import { bumpCollaborationRevision } from "./collaborators-changes";
import { initializeCollaborationProjectionAttention } from "./collaborators-notifications";
import {
  rememberCollaborationArtifactBindings,
  moveCollaborationArtifactPersonalState,
  pruneCollaborationAttentionBaselines,
} from "./collaborators-personal";
import getPool from "@cocalc/database/pool";
import type {
  CollaborationProjectionPage,
  CollaborationProjectionRequest,
} from "@cocalc/conat/inter-bay/collaborators";
import {
  ACCESS_LEASE_MS,
  entryKey,
  integer,
  MAX_ACCOUNT_RESOURCES,
  PAGE_BYTES,
  transaction,
  uuid,
  validateResource,
} from "./collaborators-common";

export interface CollaborationProjectionJob extends CollaborationProjectionRequest {
  claim_id: string;
}

/** Resumable background enumeration, never invoked from a discovery read. */
export async function seedCollaborationProjectionJobs(bay_id: string) {
  return transaction(async (db) => {
    await db.query(
      "INSERT INTO collaboration_maintenance(id,cursor) VALUES('seed','{}') ON CONFLICT DO NOTHING",
    );
    const cursor = (
      await db.query(
        "SELECT cursor FROM collaboration_maintenance WHERE id='seed' FOR UPDATE",
      )
    ).rows[0].cursor;
    const { rows } = await db.query(
      `SELECT i.account_id,i.project_id FROM account_project_index i
      JOIN accounts a ON a.account_id=i.account_id
      WHERE (i.account_id,i.project_id)>($1::uuid,$2::uuid)
      AND COALESCE(a.home_bay_id,'bay-0')=$3 AND NOT COALESCE(a.deleted,FALSE) AND NOT COALESCE(a.banned,FALSE)
      AND i.users_summary #>> ARRAY[i.account_id::text,'group'] IN ('owner','collaborator')
      ORDER BY i.account_id,i.project_id LIMIT 500`,
      [
        cursor.account_id ?? "00000000-0000-0000-0000-000000000000",
        cursor.project_id ?? "00000000-0000-0000-0000-000000000000",
        bay_id,
      ],
    );
    await db.query(
      `INSERT INTO collaboration_access(account_id,project_id,due_at)
      SELECT r.account_id,r.project_id,now() FROM jsonb_to_recordset($1::jsonb) AS r(account_id uuid,project_id uuid)
      ON CONFLICT DO NOTHING`,
      [JSON.stringify(rows)],
    );
    await db.query(
      "UPDATE collaboration_maintenance SET cursor=$1::jsonb WHERE id='seed'",
      [JSON.stringify(rows.length === 500 ? rows[rows.length - 1] : {})],
    );
    return rows.length;
  });
}

export async function claimCollaborationProjectionJobs(
  bay_id: string,
): Promise<CollaborationProjectionJob[]> {
  return transaction(async (db) => {
    const demand = demandSchedulingEnabled();
    const shared =
      demand && process.env.COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE === "1";
    const cohort = shared
      ? await claimDemandAccounts(db, bay_id, "projection")
      : [];
    if (shared && !cohort.length) return [];
    const demandedAccount =
      demand && !shared
        ? await claimDemandAccount(db, bay_id, "projection")
        : undefined;
    if (demand && !shared && !demandedAccount) return [];
    const { rows } = shared
      ? await db.query(
          `SELECT x.* FROM unnest($2::uuid[]) AS q(account_id)
       CROSS JOIN LATERAL (
         SELECT x.account_id,x.project_id,x.generation,x.revision,x.after_key,x.relation_after
         FROM collaboration_access x JOIN accounts a USING(account_id)
         WHERE x.account_id=q.account_id AND x.due_at<=clock_timestamp()
         AND (x.claim_until IS NULL OR x.claim_until<clock_timestamp())
         AND (x.lease_claim_until IS NULL OR x.lease_claim_until<clock_timestamp())
         AND ${demandScopePredicate}
         AND COALESCE(a.home_bay_id,'bay-0')=$1 AND a.deleted IS NOT TRUE AND a.banned IS NOT TRUE
         ORDER BY x.due_at,x.project_id LIMIT $3 FOR UPDATE OF x SKIP LOCKED
       ) x`,
          [bay_id, cohort, Math.floor(8 / cohort.length)],
        )
      : await db.query(
          `SELECT x.account_id,x.project_id,x.generation,x.revision,x.after_key,x.relation_after
      FROM collaboration_access x JOIN accounts a USING(account_id)
      WHERE x.due_at<=now() AND (x.claim_until IS NULL OR x.claim_until<now())
      AND (x.lease_claim_until IS NULL OR x.lease_claim_until<now())
      ${demand ? `AND x.account_id=$2 AND ${demandScopePredicate}` : ""}
      AND COALESCE(a.home_bay_id,'bay-0')=$1 AND NOT COALESCE(a.deleted,FALSE) AND NOT COALESCE(a.banned,FALSE)
      ORDER BY x.due_at,x.account_id,x.project_id LIMIT 8 FOR UPDATE OF x SKIP LOCKED`,
          demand ? [bay_id, demandedAccount] : [bay_id],
        );
    const result: CollaborationProjectionJob[] = [];
    for (const row of rows) {
      const claim_id = randomUUID();
      await db.query(
        "UPDATE collaboration_access SET claim_id=$3,grant_request_id=$3,claim_until=now()+interval '30 seconds' WHERE account_id=$1 AND project_id=$2",
        [row.account_id, row.project_id, claim_id],
      );
      result.push({
        account_id: row.account_id,
        project_id: row.project_id,
        generation: row.generation,
        revision: Number(row.revision),
        after_key: row.after_key,
        claim_id,
        ...(row.relation_after ? { relation_after: row.relation_after } : {}),
      });
    }
    return result;
  });
}

export async function applyCollaborationProjection(
  job: CollaborationProjectionJob,
  page: CollaborationProjectionPage,
  requested_at: number,
) {
  if (
    !Number.isFinite(requested_at) ||
    requested_at > Date.now() ||
    Date.now() - requested_at >= ACCESS_LEASE_MS
  )
    throw Error("expired collaboration projection delivery");
  if (
    Buffer.byteLength(JSON.stringify(page)) > PAGE_BYTES ||
    (page.allowed && page.items.length > 50)
  )
    throw Error("projection page limit exceeded");
  return transaction(async (db) => {
    // Serialize the quota check across this account's project jobs.
    await assertAccountNotRehoming({
      db,
      account_id: job.account_id,
      action: "apply collaboration projection",
    });
    await assertAccountWriteOnHomeBay({
      db,
      account_id: job.account_id,
      action: "apply collaboration projection",
    });
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `collaboration-account:${job.account_id}`,
    ]);
    const access = (
      await db.query(
        "SELECT * FROM collaboration_access WHERE account_id=$1 AND project_id=$2 FOR UPDATE",
        [job.account_id, job.project_id],
      )
    ).rows[0];
    if (
      !access ||
      access.claim_id !== job.claim_id ||
      access.grant_request_id !== job.claim_id ||
      access.generation !== job.generation ||
      Number(access.revision) !== job.revision ||
      access.after_key !== job.after_key ||
      !sameParticipantContinuation(
        access.relation_after ?? undefined,
        job.relation_after,
      )
    )
      return false;
    if (!page.allowed || page.reset || page.items.length)
      await rememberCollaborationArtifactBindings(
        db,
        job.account_id,
        job.project_id,
      );
    const visible = await db.query(
      `SELECT 1 FROM account_project_index WHERE account_id=$1 AND project_id=$2
      AND users_summary #>> ARRAY[$1::text,'group'] IN ('owner','collaborator')`,
      [job.account_id, job.project_id],
    );
    if (!page.allowed || !visible.rows.length) {
      await db.query(
        "DELETE FROM collaboration_index WHERE account_id=$1 AND project_id=$2",
        [job.account_id, job.project_id],
      );
      await pruneCollaborationAttentionBaselines(
        db,
        job.account_id,
        job.project_id,
      );
      await db.query(
        `UPDATE collaboration_access SET generation=NULL,granted_generation=NULL,revision=0,after_key='',relation_after=NULL,lease_until=NULL,complete=FALSE,
        claim_id=NULL,claim_until=NULL,due_at=now()+interval '30 seconds',last_error=NULL,failures=0 WHERE account_id=$1 AND project_id=$2`,
        [job.account_id, job.project_id],
      );
      if (access.generation != null)
        await bumpCollaborationRevision(db, job.account_id);
      return true;
    }
    if (page.reset) {
      await db.query(
        "DELETE FROM collaboration_index WHERE account_id=$1 AND project_id=$2",
        [job.account_id, job.project_id],
      );
    } else if (page.generation !== job.generation)
      throw Error("projection generation mismatch");
    const attention_generation = page.attention_generation ?? page.generation;
    uuid(attention_generation, "attention generation");
    const deleted = page.items
      .filter((item) => item.resource == null)
      .map((item) => item.entry_key);
    await db.query(
      "DELETE FROM collaboration_index WHERE account_id=$1 AND project_id=$2 AND entry_key=ANY($3::text[])",
      [job.account_id, job.project_id, deleted],
    );
    const entries = page.items.flatMap((item) => {
      if (item.resource == null) return [];
      const resource = validateResource(item.resource);
      if (
        resource.project_id !== job.project_id ||
        entryKey(resource) !== item.entry_key
      )
        throw Error("projection identity mismatch");
      const initial_activity =
        item.initial_activity == null
          ? resource.activity
          : integer(item.initial_activity, "initial attention activity");
      if (initial_activity > resource.activity)
        throw Error("initial attention activity exceeds resource activity");
      return [
        {
          entry_key: item.entry_key,
          kind: resource.kind,
          activity: resource.updated_at,
          metadata: resource,
          created_by: resource.created_by ?? null,
          participant_ids: resource.participant_ids,
          title: resource.title,
          initial_activity,
          artifact_entry_ids: item.resource.artifact_entry_ids,
          agent_resource_ids: item.resource.agent_resource_ids,
        },
      ];
    });
    for (const entry of entries) {
      await moveCollaborationAgentPersonalState(db, job.account_id, {
        ...entry.metadata,
        agent_resource_ids: entry.agent_resource_ids,
      });
      await moveCollaborationArtifactPersonalState(
        db,
        job.account_id,
        { ...entry.metadata, artifact_entry_ids: entry.artifact_entry_ids },
        entry.entry_key,
      );
    }
    if (entries.length)
      await db.query(
        `INSERT INTO collaboration_index(account_id,entry_key,project_id,generation,kind,activity,metadata,created_by,participant_ids,search_text)
      SELECT $1,e.entry_key,$2,$3,e.kind,e.activity,e.metadata,e.created_by,e.participant_ids,
        e.title || ' ' || COALESCE(p.alias,'') FROM jsonb_to_recordset($4::jsonb)
        AS e(entry_key text,kind text,activity bigint,metadata jsonb,created_by uuid,participant_ids uuid[],title text)
      LEFT JOIN collaboration_personal p ON p.account_id=$1 AND p.entry_key=e.entry_key
      ON CONFLICT(account_id,entry_key) DO UPDATE SET generation=excluded.generation,kind=excluded.kind,
        activity=excluded.activity,metadata=excluded.metadata,created_by=excluded.created_by,
        participant_ids=excluded.participant_ids,search_text=excluded.search_text`,
        [
          job.account_id,
          job.project_id,
          page.generation,
          JSON.stringify(entries),
        ],
      );
    await applyHomeParticipantProjection(db, job, page);
    const count = entries.length
      ? await db.query(
          "SELECT count(*) AS n FROM collaboration_index WHERE account_id=$1",
          [job.account_id],
        )
      : null;
    if (count && Number(count.rows[0].n) > MAX_ACCOUNT_RESOURCES)
      throw Error(
        "collaboration account projection quota exceeded; indexing incomplete",
      );
    await initializeCollaborationProjectionAttention(db, {
      account_id: job.account_id,
      project_id: job.project_id,
      generation: attention_generation,
      resources: entries.map((entry) => ({
        ...entry.metadata,
        activity: entry.initial_activity,
      })),
    });
    // Missing rows may belong to later resnapshot pages, not deleted resources.
    if (page.complete)
      await pruneCollaborationAttentionBaselines(
        db,
        job.account_id,
        job.project_id,
      );
    if (entries.length)
      await rememberCollaborationArtifactBindings(
        db,
        job.account_id,
        job.project_id,
      );
    await db.query(
      `UPDATE collaboration_access SET generation=$3,granted_generation=$3,revision=$4,after_key=$5,lease_until=$6,
      lease_due_at=now()+interval '20 seconds',lease_claim_until=NULL,
      complete=$7,attention_generation=$9,relation_after=$10::jsonb,due_at=now()+($8::integer*interval '1 millisecond'),claim_id=NULL,claim_until=NULL,failures=0,last_error=NULL
      WHERE account_id=$1 AND project_id=$2`,
      [
        job.account_id,
        job.project_id,
        page.generation,
        page.revision,
        page.after_key,
        new Date(requested_at + ACCESS_LEASE_MS),
        page.complete,
        page.complete ? 20000 : 0,
        attention_generation,
        page.relation_after ? JSON.stringify(page.relation_after) : null,
      ],
    );
    if (
      page.reset ||
      page.items.length ||
      !access.lease_until ||
      new Date(access.lease_until).getTime() <= Date.now()
    )
      await bumpCollaborationRevision(db, job.account_id);
    return true;
  });
}

export async function failCollaborationProjection(
  job: CollaborationProjectionJob,
  error: unknown,
) {
  // Store a bounded, non-sensitive diagnostic, never RPC bodies or metadata.
  const message =
    error instanceof Error && /quota|limit/.test(error.message)
      ? "projection capacity limit; indexing incomplete"
      : "projection unavailable; retrying";
  await getPool().query(
    `UPDATE collaboration_access SET failures=LEAST(failures+1,10),last_error=$4,
    due_at=now()+(LEAST(60,power(2,LEAST(failures,6))) * interval '1 second'),claim_id=NULL,claim_until=NULL
    WHERE account_id=$1 AND project_id=$2 AND claim_id=$3`,
    [job.account_id, job.project_id, job.claim_id, message],
  );
}

// Shared with the isolated PostgreSQL scale fixture so EXPLAIN measures the
// production queries, not an independently maintained approximation.
export const cleanupCandidatesSql = `SELECT account_id,project_id FROM collaboration_access
  WHERE (account_id,project_id)>($1::uuid,$2::uuid)
  ORDER BY account_id,project_id LIMIT 20`;

export function cleanupStaleSql(bounded: boolean) {
  return `SELECT x.account_id,x.project_id FROM collaboration_access x
    ${bounded ? `JOIN jsonb_to_recordset($2::jsonb) AS c(account_id uuid,project_id uuid) USING(account_id,project_id)` : ""}
    WHERE NOT EXISTS(SELECT 1 FROM account_project_index p JOIN accounts a USING(account_id)
      WHERE p.account_id=x.account_id AND p.project_id=x.project_id
      AND COALESCE(a.home_bay_id,'bay-0')=$1 AND NOT COALESCE(a.deleted,FALSE) AND NOT COALESCE(a.banned,FALSE)
      AND p.users_summary #>> ARRAY[p.account_id::text,'group'] IN ('owner','collaborator'))
    LIMIT 20 FOR UPDATE OF x SKIP LOCKED`;
}

/** Bounded deletion of inaccessible metadata; leases already gate reads. */
export async function cleanCollaborationProjections(bay_id: string) {
  return transaction(async (db) => {
    let candidates: { account_id: string; project_id: string }[] | undefined;
    if (demandSchedulingEnabled()) {
      await db.query(
        "INSERT INTO collaboration_maintenance(id,cursor) VALUES('cleanup','{}') ON CONFLICT DO NOTHING",
      );
      const state = (
        await db.query(
          "SELECT cursor FROM collaboration_maintenance WHERE id='cleanup' FOR UPDATE",
        )
      ).rows[0].cursor;
      const now = (await db.query("SELECT clock_timestamp() AS now")).rows[0]
        .now as Date;
      if (state.next_at && new Date(state.next_at).getTime() > now.getTime())
        return 0;
      candidates = (
        await db.query(cleanupCandidatesSql, [
          state.account_id ?? "00000000-0000-0000-0000-000000000000",
          state.project_id ?? "00000000-0000-0000-0000-000000000000",
        ])
      ).rows;
      // A skipped row lock is revisited on the next bounded repair cycle. This
      // cursor is not an access authorization or a proof of complete cleanup.
      await db.query(
        "UPDATE collaboration_maintenance SET cursor=$1::jsonb WHERE id='cleanup'",
        [
          JSON.stringify({
            ...(candidates!.length === 20 ? candidates!.at(-1) : {}),
            next_at: new Date(now.getTime() + 60_000).toISOString(),
          }),
        ],
      );
      if (!candidates!.length) return 0;
    }
    const { rows } = await db.query(
      cleanupStaleSql(candidates !== undefined),
      candidates ? [bay_id, JSON.stringify(candidates)] : [bay_id],
    );
    for (const row of rows) {
      await rememberCollaborationArtifactBindings(
        db,
        row.account_id,
        row.project_id,
      );
      await bumpCollaborationRevision(db, row.account_id);
      await db.query(
        "DELETE FROM collaboration_index WHERE account_id=$1 AND project_id=$2",
        [row.account_id, row.project_id],
      );
      await pruneCollaborationAttentionBaselines(
        db,
        row.account_id,
        row.project_id,
      );
      await db.query(
        "DELETE FROM collaboration_access WHERE account_id=$1 AND project_id=$2",
        [row.account_id, row.project_id],
      );
    }
    return rows.length;
  });
}
