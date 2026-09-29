/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { uuidsha1 } from "@cocalc/util/misc";
import { validateCollaborationMessageEvent } from "@cocalc/util/collaboration-attention";
import { assertProjectNotRehoming } from "../project-rehome-fence";
import { transaction, uuid } from "./collaborators-common";

export const MAX_NOTIFICATION_RECIPIENTS_PER_PROJECT = 50_000;

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
