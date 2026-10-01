/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import getPool from "@cocalc/database/pool";
import type { PeopleInvitationOperation } from "@cocalc/util/people-invitations";
import type { PeopleCollaborationInvitationHistoryRow } from "@cocalc/util/people-invitation-history";
import type { InterBayPeopleStorageApi } from "@cocalc/conat/inter-bay/people-storage";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";
import { peopleHome, uuid, withPeopleAccount } from "./common";
import { ensurePeopleContactInTransaction } from "./contacts";
import { bumpPeopleRevision } from "./schema";
import type { PeopleDb } from "./schema";

async function upsert(
  db: PeopleDb,
  account_id: string,
  i: PeopleCollaborationInvitationHistoryRow,
) {
  const prior = (
    await db.query(
      "SELECT source_version::text,source_bay_id,invitation->>'kind' AS kind FROM people_invitation_index WHERE account_id=$1 AND invitation_id=$2",
      [account_id, i.invitation_id],
    )
  ).rows[0];
  if (prior && prior.source_bay_id !== i.source_bay_id)
    throw Error("collaboration source transfer unsupported");
  if (prior && prior.kind !== "collaboration")
    throw Error("invitation identity kind collision");
  if (prior && BigInt(prior.source_version) >= BigInt(i.source_version))
    return false;
  await db.query(
    `INSERT INTO people_invitation_index(account_id,invitation_id,project_id,source_bay_id,source_version,
    sender_account_id,recipient_account_id,person_id,status,created_at,invitation)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
    ON CONFLICT(account_id,invitation_id) DO UPDATE SET source_version=EXCLUDED.source_version,
      status=EXCLUDED.status,invitation=EXCLUDED.invitation`,
    [
      account_id,
      i.invitation_id,
      i.project_id,
      i.source_bay_id,
      i.source_version,
      i.sender_account_id,
      i.recipient_account_id,
      i.person_id,
      i.status,
      i.created_at,
      JSON.stringify(i),
    ],
  );
  await bumpPeopleRevision(db, account_id);
  return true;
}
/** Sender-home service hook, after its immutable reviewed receipts commit.
 * The operation remains the retry source if this transaction fails. No email,
 * credential, bearer link or arbitrary operation payload enters the outbox.
 */
export async function recordPeopleInvitationOperation(
  operation: PeopleInvitationOperation,
) {
  uuid(operation.account_id, "sender account_id");
  if (
    !Number.isSafeInteger(operation.source_version) ||
    operation.source_version < 1 ||
    operation.outcomes.length > 25
  )
    throw Error("invalid operation projection version");
  return withPeopleAccount(operation.account_id, async (db) => {
    for (const receipt of operation.outcomes) {
      if (
        !receipt.collaboration_invitation_id ||
        !["created", "reused", "notified"].includes(receipt.status)
      )
        continue;
      uuid(receipt.collaboration_invitation_id, "collaboration invitation_id");
      uuid(receipt.project_id, "project_id");
      const recipient = operation.payload.recipient;
      const person = await ensurePeopleContactInTransaction(db, {
        account_id: operation.account_id,
        recipient:
          recipient.kind === "email"
            ? { email: recipient.email_address }
            : { account_id: recipient.account_id },
      });
      const notification_id =
        receipt.delivery.find(
          (d) =>
            d.channel === "notification" &&
            d.status !== "suppressed" &&
            operation.payload.channels.notification,
        )?.receipt_id ?? null;
      if (notification_id) uuid(notification_id, "notification_id");
      const i: PeopleCollaborationInvitationHistoryRow = {
        invitation_id: receipt.collaboration_invitation_id,
        kind: "collaboration",
        project_id: receipt.project_id,
        sender_account_id: operation.account_id,
        recipient_account_id:
          recipient.kind === "account" ? recipient.account_id : null,
        person_id: person.person_id,
        message: operation.payload.message,
        created_at: new Date(operation.created_at).toISOString(),
        updated_at: new Date(operation.updated_at).toISOString(),
        source_bay_id: getConfiguredBayId(),
        source_version: `${operation.source_version}`,
        status: "active",
        ...(operation.payload.target
          ? { target: operation.payload.target }
          : {}),
        access_invite_ids: receipt.access_invite_id
          ? [receipt.access_invite_id]
          : [],
        delivery: receipt.delivery.map(({ channel, status, receipt_id }) => ({
          channel,
          status,
          ...(receipt_id ? { receipt_id } : {}),
        })),
        notification_id,
        notification_read: null,
        notification_archived: null,
        read_at: null,
        dismissed_at: null,
      };
      if (!(await upsert(db, operation.account_id, i))) continue;
      if (
        i.recipient_account_id &&
        i.recipient_account_id !== i.sender_account_id
      ) {
        await db.query(
          `INSERT INTO people_collaboration_outbox(account_id,invitation_id,version,invitation)
          VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(account_id,invitation_id) DO UPDATE SET
          version=EXCLUDED.version,invitation=EXCLUDED.invitation,delivered_at=NULL,attempts=0,available_at=now(),lease_until=NULL`,
          [
            operation.account_id,
            i.invitation_id,
            i.source_version,
            JSON.stringify({ ...i, person_id: null }),
          ],
        );
      }
    }
  });
}
export const applyCollaborationProjection: InterBayPeopleStorageApi["applyCollaborationProjection"] =
  async (opts) => {
    const i = opts.invitation;
    uuid(i.invitation_id, "invitation_id");
    uuid(i.project_id, "project_id");
    if (
      i.kind !== "collaboration" ||
      i.recipient_account_id !== opts.account_id ||
      i.source_bay_id !== opts.source_bay_id ||
      (await peopleHome(i.sender_account_id)) !== opts.source_bay_id ||
      !/^[1-9][0-9]{0,18}$/.test(i.source_version) ||
      !["active", "withdrawn"].includes(i.status)
    )
      throw Error("invalid collaboration projection authority");
    if (i.notification_id) uuid(i.notification_id, "notification_id");
    const safe: PeopleCollaborationInvitationHistoryRow = {
      invitation_id: i.invitation_id,
      project_id: i.project_id,
      kind: "collaboration",
      status: i.status,
      sender_account_id: i.sender_account_id,
      recipient_account_id: i.recipient_account_id,
      person_id: null,
      message: i.message?.slice(0, 2000) ?? null,
      created_at: new Date(i.created_at).toISOString(),
      updated_at: new Date(i.updated_at).toISOString(),
      source_bay_id: opts.source_bay_id,
      source_version: i.source_version,
      ...(i.target
        ? {
            target: {
              project_id: i.target.project_id,
              kind: i.target.kind,
              resource_id: i.target.resource_id,
              label: i.target.label,
            },
          }
        : {}),
      access_invite_ids: i.access_invite_ids.slice(0, 25),
      delivery: i.delivery.map(({ channel, status, receipt_id }) => ({
        channel,
        status,
        ...(receipt_id ? { receipt_id } : {}),
      })),
      notification_id: i.notification_id,
      notification_read: null,
      notification_archived: null,
      read_at: null,
      dismissed_at: null,
    };
    await withPeopleAccount(opts.account_id, (db) =>
      upsert(db, opts.account_id, safe),
    );
  };
export async function drainPeopleCollaborationOutbox(limit = 25) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw Error("invalid outbox limit");
  const pool = getPool();
  const jobs = (
    await pool.query(
      `WITH due AS (SELECT account_id,invitation_id FROM people_collaboration_outbox
    WHERE delivered_at IS NULL AND available_at<=now() AND (lease_until IS NULL OR lease_until<now())
    ORDER BY available_at,invitation_id LIMIT $1 FOR UPDATE SKIP LOCKED)
    UPDATE people_collaboration_outbox o SET lease_until=now()+interval '10 minutes',attempts=o.attempts+1
    FROM due WHERE o.account_id=due.account_id AND o.invitation_id=due.invitation_id RETURNING o.*`,
      [limit],
    )
  ).rows;
  const { peopleStorageClient } = await import("./api");
  for (const job of jobs) {
    try {
      if ((await peopleHome(job.account_id)) !== getConfiguredBayId())
        throw Error("stale collaboration source");
      const account = await getClusterAccountById(
        job.invitation.recipient_account_id,
      );
      if (!account?.home_bay_id) throw Error("recipient home unavailable");
      await peopleStorageClient(
        account.home_bay_id,
      ).applyCollaborationProjection({
        account_id: job.invitation.recipient_account_id,
        source_bay_id: getConfiguredBayId(),
        invitation: job.invitation,
      });
      await pool.query(
        "UPDATE people_collaboration_outbox SET delivered_at=now(),lease_until=NULL WHERE account_id=$1 AND invitation_id=$2 AND version=$3",
        [job.account_id, job.invitation_id, job.version],
      );
    } catch {
      await pool.query(
        `UPDATE people_collaboration_outbox SET lease_until=NULL,
        available_at=now()+LEAST(3600,POWER(2,LEAST(attempts,12)))*interval '1 second'
        WHERE account_id=$1 AND invitation_id=$2 AND version=$3`,
        [job.account_id, job.invitation_id, job.version],
      );
    }
  }
  return jobs.length;
}
