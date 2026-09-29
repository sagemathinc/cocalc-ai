/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { uuidsha1 } from "@cocalc/util/misc";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "@cocalc/database/pool";
import getPool from "@cocalc/database/pool";
import type { CollaborationMessageEvent } from "@cocalc/util/collaboration-attention";
import { validateCollaborationMessageEvent } from "@cocalc/util/collaboration-attention";
import {
  assertProjectNotRehoming,
  ProjectRehomeInProgressError,
} from "../project-rehome-fence";
import { transaction, uuid } from "./collaborators-common";

export const MAX_NOTIFICATION_RECIPIENTS_PER_PROJECT = 50_000;

export interface NotificationProjectJob {
  project_id: string;
  claim_id: string;
}

/** Indexed queue of projects with real work, never an account/membership scan.
 * Project ownership/rehome is checked again by every mutating work operation.
 */
export async function claimNotificationProjects(
  bay_id: string,
): Promise<NotificationProjectJob[]> {
  const tables = (
    await getPool()
      .query(`SELECT to_regclass('public.project_rehome_operations') AS operations,
    to_regclass('public.project_collaboration_rehome_transfers') AS transfers`)
  ).rows[0];
  const candidates = await getPool().query(
    `SELECT c.project_id
    FROM collaboration_projects c JOIN projects p USING(project_id)
    WHERE c.notification_due<=clock_timestamp() AND p.owning_bay_id=$1
    ${tables.operations ? "AND NOT EXISTS(SELECT 1 FROM project_rehome_operations o WHERE o.project_id=p.project_id AND o.status='running')" : ""}
    ${
      tables.transfers
        ? `AND NOT EXISTS(SELECT 1 FROM project_collaboration_rehome_transfers t WHERE t.project_id=p.project_id
      AND ((t.direction='export' AND t.state IN ('exporting','exported')) OR (t.direction='import' AND t.state IN ('staging','ready'))))`
        : ""
    }
    ORDER BY c.notification_due,c.project_id LIMIT 8`,
    [bay_id],
  );
  const jobs: NotificationProjectJob[] = [];
  for (const row of candidates.rows) {
    try {
      const job = await transaction(async (db) => {
        await lockOwner(db, row.project_id, bay_id);
        const claim_id = randomUUID();
        const claimed = await db.query(
          `UPDATE collaboration_projects SET notification_claim=$2,
          notification_due=clock_timestamp()+interval '60 seconds'
          WHERE project_id=$1 AND notification_due<=clock_timestamp() RETURNING project_id`,
          [row.project_id, claim_id],
        );
        return claimed.rows.length
          ? { project_id: row.project_id, claim_id }
          : null;
      });
      if (job) jobs.push(job);
    } catch (err) {
      if (!(err instanceof ProjectRehomeInProgressError)) throw err;
    }
  }
  return jobs;
}

export async function finishNotificationProject(
  job: NotificationProjectJob,
  bay_id: string,
) {
  await transaction(async (db) => {
    await lockOwner(db, job.project_id, bay_id);
    await db.query(
      `UPDATE collaboration_projects SET notification_claim=NULL,
      notification_due=(SELECT CASE WHEN due IS NULL THEN NULL
        ELSE GREATEST(due,clock_timestamp()+interval '1 second') END FROM (
        SELECT min(due) AS due FROM (
          SELECT min(fanout_due) AS due FROM collaboration_notification_events
            WHERE project_id=$1 AND fanout_pending
          UNION ALL SELECT min(due_at) FROM collaboration_notification_recipients WHERE project_id=$1
        ) work) schedule)
      WHERE project_id=$1 AND notification_claim=$2`,
      [job.project_id, job.claim_id],
    );
  });
}

export async function nextNotificationExpansion(
  project_id: string,
): Promise<string | undefined> {
  const { rows } = await getPool().query(
    `SELECT event_id FROM collaboration_notification_events
    WHERE project_id=$1 AND fanout_pending AND fanout_due<=clock_timestamp()
    ORDER BY fanout_due,event_id LIMIT 1`,
    [project_id],
  );
  return rows[0]?.event_id;
}

async function lockOwner(db: PoolClient, project_id: string, bay_id: string) {
  await assertProjectNotRehoming({
    db,
    project_id,
    action: "claim or settle notification work",
  });
  const owner = await db.query(
    "SELECT project_id FROM projects WHERE project_id=$1 AND owning_bay_id=$2 FOR UPDATE",
    [project_id, bay_id],
  );
  if (!owner.rows.length) throw Error("notification project owner unavailable");
}

export interface NotificationRecipientClaim {
  id: string;
  claim_id: string;
  account_id: string;
  membership_epoch: string;
  event: CollaborationMessageEvent;
}

/** Internal work receipt, NOT authorization to disclose an event. The receiver
 * must resolve current home/owner authority and check membership before use.
 * An unknown delivery outcome retries the same obligation, never acknowledges it.
 */
export async function claimCollaborationNotificationRecipients({
  project_id,
  bay_id,
  limit = 25,
}: {
  project_id: string;
  bay_id: string;
  limit?: number;
}): Promise<NotificationRecipientClaim[]> {
  uuid(project_id, "project_id");
  if (!Number.isInteger(limit) || limit < 1 || limit > 25)
    throw Error("invalid recipient claim limit");
  return transaction(async (db) => {
    await lockOwner(db, project_id, bay_id);
    // Read wall time after the potentially contended ownership fence. A worker
    // must never receive an already-expired lease after waiting for a lock.
    const claims = await db.query(
      `WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS t),
      due AS (SELECT r.id FROM collaboration_notification_recipients r, clock
        WHERE r.project_id=$1 AND r.due_at<=clock.t
          AND (r.claim_until IS NULL OR r.claim_until<=clock.t)
        ORDER BY r.due_at,r.id LIMIT $2 FOR UPDATE OF r SKIP LOCKED)
      UPDATE collaboration_notification_recipients r SET claim_id=$3,
        claim_until=clock.t+interval '60 seconds',due_at=clock.t+interval '60 seconds'
      FROM due,clock WHERE r.id=due.id
      RETURNING r.id,r.event_id,r.account_id,r.membership_epoch,r.claim_id`,
      [project_id, limit, randomUUID()],
    );
    const result: NotificationRecipientClaim[] = [];
    if (!claims.rows.length) return result;
    const sources = await db.query(
      "SELECT event_id,event_json FROM collaboration_notification_events WHERE event_id=ANY($1::uuid[]) AND project_id=$2",
      [claims.rows.map((row) => row.event_id), project_id],
    );
    const events = new Map(
      sources.rows.map((row) => [row.event_id, row.event_json]),
    );
    for (const row of claims.rows) {
      if (!events.has(row.event_id))
        throw Error("pending notification source missing");
      result.push({
        id: row.id,
        claim_id: row.claim_id,
        account_id: row.account_id,
        membership_epoch: row.membership_epoch,
        event: validateCollaborationMessageEvent(events.get(row.event_id)),
      });
    }
    return result;
  });
}

/** Call acknowledge only after durable recipient-home acceptance or definitive
 * suppression/revocation. Retry includes timeouts/unknown outcomes. An expired
 * or superseded claim cannot change the obligation, even after a delayed reply.
 */
export async function settleCollaborationNotificationRecipient({
  project_id,
  bay_id,
  id,
  claim_id,
  outcome,
}: {
  project_id: string;
  bay_id: string;
  id: string;
  claim_id: string;
  outcome: "acknowledge" | "retry";
}): Promise<boolean> {
  uuid(project_id, "project_id");
  uuid(id, "recipient obligation");
  uuid(claim_id, "recipient claim");
  if (outcome !== "acknowledge" && outcome !== "retry")
    throw Error("invalid notification claim outcome");
  return transaction(async (db) => {
    await lockOwner(db, project_id, bay_id);
    const predicate = `WHERE project_id=$1 AND id=$2 AND claim_id=$3
      AND claim_until>clock_timestamp() RETURNING id`;
    const settled = await db.query(
      outcome === "acknowledge"
        ? `DELETE FROM collaboration_notification_recipients ${predicate}`
        : `UPDATE collaboration_notification_recipients SET claim_id=NULL,
          claim_until=NULL,due_at=clock_timestamp()+interval '5 seconds' ${predicate}`,
      [project_id, id, claim_id],
    );
    return settled.rows.length === 1;
  });
}

/** Service-internal owner transaction; no delivery, home lookup, or RPC inside.
 * Capture is opt-in while the replacement delivery worker is being validated.
 * Pending events and recipient obligations must survive event-log retention.
 */
export async function expandCollaborationNotificationEvent({
  event_id,
  bay_id,
  limit = 100,
}: {
  event_id: string;
  bay_id: string;
  limit?: number;
}): Promise<{
  state: "missing" | "complete" | "pending" | "deferred";
  added: number;
}> {
  uuid(event_id, "notification event");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw Error("invalid recipient page limit");
  return transaction(async (db) => {
    const event = (
      await db.query(
        "SELECT project_id FROM collaboration_notification_events WHERE event_id=$1",
        [event_id],
      )
    ).rows[0];
    if (!event) return { state: "missing", added: 0 };
    const project_id = event.project_id;
    await assertProjectNotRehoming({
      db,
      project_id,
      action: "expand notification recipients",
    });
    // Match ingestion's project-before-event lock order. Ownership cannot move
    // between selecting recipients and advancing the persisted cursor.
    const project = (
      await db.query(
        "SELECT users,deleted FROM projects WHERE project_id=$1 AND owning_bay_id=$2 FOR UPDATE",
        [project_id, bay_id],
      )
    ).rows[0];
    if (!project) throw Error("notification project owner unavailable");
    const source = (
      await db.query(
        "SELECT * FROM collaboration_notification_events WHERE event_id=$1 FOR UPDATE",
        [event_id],
      )
    ).rows[0];
    if (!source) return { state: "missing", added: 0 };
    if (!source.fanout_pending) return { state: "complete", added: 0 };
    const fact = validateCollaborationMessageEvent(source.event_json);
    const members = project.deleted
      ? []
      : (
          await db.query(
            `SELECT m.account_id,m.epoch
      FROM collaboration_memberships m WHERE m.project_id=$1 AND m.account_id>$2::uuid
      AND m.notification_position<$3 AND m.account_id<>$4
      AND $5::jsonb #>> ARRAY[m.account_id::text,'group'] IN ('owner','collaborator')
      ORDER BY m.account_id LIMIT $6`,
            [
              project_id,
              source.fanout_after ?? "00000000-0000-0000-0000-000000000000",
              source.position,
              fact.actor_account_id,
              JSON.stringify(project.users ?? {}),
              limit + 1,
            ],
          )
        ).rows;
    const selected = members.slice(0, limit);
    const count = Number(
      (
        await db.query(
          "SELECT count(*) AS n FROM collaboration_notification_recipients WHERE project_id=$1",
          [project_id],
        )
      ).rows[0].n,
    );
    if (count + selected.length > MAX_NOTIFICATION_RECIPIENTS_PER_PROJECT) {
      await db.query(
        "UPDATE collaboration_notification_events SET fanout_due=now()+interval '5 seconds' WHERE event_id=$1",
        [event_id],
      );
      return { state: "deferred", added: 0 };
    }
    const recipients = selected.map((row) => ({
      id: uuidsha1(JSON.stringify([event_id, row.account_id, row.epoch])),
      account_id: row.account_id,
      membership_epoch: row.epoch,
    }));
    const inserted = await db.query(
      `INSERT INTO collaboration_notification_recipients(id,event_id,project_id,account_id,membership_epoch)
      SELECT r.id,$1,$2,r.account_id,r.membership_epoch FROM jsonb_to_recordset($3::jsonb)
        AS r(id uuid,account_id uuid,membership_epoch uuid) ON CONFLICT(id) DO NOTHING RETURNING id`,
      [event_id, project_id, JSON.stringify(recipients)],
    );
    const complete = members.length <= limit;
    await db.query(
      `UPDATE collaboration_notification_events SET fanout_pending=$2,
      fanout_after=COALESCE($3,fanout_after),fanout_due=CASE WHEN $2 THEN now() ELSE NULL END
      WHERE event_id=$1`,
      [event_id, !complete, selected.at(-1)?.account_id ?? null],
    );
    return {
      state: complete ? "complete" : "pending",
      added: inserted.rows.length,
    };
  });
}
