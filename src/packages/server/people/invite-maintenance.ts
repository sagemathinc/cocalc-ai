/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import getPool from "@cocalc/database/pool";
import getLogger from "@cocalc/backend/logger";
import { getSecretSettingsKey } from "@cocalc/database/settings/secret-settings";
import { decryptSecretSettingValue } from "@cocalc/util/secret-settings-crypto";
import type { PeopleAccessInvitation } from "@cocalc/util/people-invitation-history";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";
import { ensureProjectCollabInviteEmailTokenSchema } from "@cocalc/server/projects/collaborators";
import { peopleStorageClient } from "./api";
import { ensurePeopleSchema } from "./schema";
import { drainPeopleCollaborationOutbox } from "./collaboration-projections";
import { purgeDeletedPeopleAccounts } from "./rehome";

const logger = getLogger("people:invite-maintenance");
let running = false;

export async function backfillPeopleInvites(limit = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw Error("invalid backfill limit");
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    const state = (
      await db.query(
        "SELECT * FROM people_invite_backfill WHERE singleton FOR UPDATE SKIP LOCKED",
      )
    ).rows[0];
    if (!state || state.complete) {
      await db.query("COMMIT");
      return 0;
    }
    const rows = (
      await db.query(
        `SELECT invite_id FROM project_collab_invites
      WHERE ($1::uuid IS NULL OR invite_id>$1) ORDER BY invite_id LIMIT $2`,
        [state.after_id, limit],
      )
    ).rows;
    // A no-op canonical write invokes the same atomic version/outbox trigger.
    // New inserts racing behind this cursor already have an outbox entry.
    if (rows.length)
      await db.query(
        `UPDATE project_collab_invites SET people_version=people_version
      WHERE invite_id=ANY($1::uuid[]) AND people_version=0`,
        [rows.map((r) => r.invite_id)],
      );
    await db.query(
      `UPDATE people_invite_backfill SET after_id=COALESCE($1,after_id),complete=$2,updated_at=now() WHERE singleton`,
      [rows[rows.length - 1]?.invite_id ?? null, rows.length < limit],
    );
    await db.query("COMMIT");
    return rows.length;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}

export async function drainPeopleInviteOutbox(limit = 25) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw Error("invalid outbox limit");
  const pool = getPool();
  const jobs = (
    await pool.query(
      `WITH due AS (
    SELECT invitation_id FROM people_invite_outbox WHERE delivered_at IS NULL
      AND available_at<=now() AND (lease_until IS NULL OR lease_until<now())
    ORDER BY available_at,invitation_id LIMIT $1 FOR UPDATE SKIP LOCKED)
    UPDATE people_invite_outbox o SET lease_until=now()+interval '10 minutes',attempts=o.attempts+1
    FROM due WHERE o.invitation_id=due.invitation_id RETURNING o.*`,
      [limit],
    )
  ).rows;
  // Sequential, bounded RPCs. A version-conditional ack cannot erase a newer
  // lifecycle event that replaces a leased row while this delivery is running.
  for (const job of jobs) {
    try {
      const route = await resolveProjectBay(job.project_id);
      if (!route || route.bay_id !== getConfiguredBayId())
        throw Error("source no longer authoritative");
      const { email_ciphertext, ...fields } = job.payload;
      const invitation: PeopleAccessInvitation = {
        ...fields,
        person_id: null,
        source_version: `${job.version}`,
        source_bay_id: route.bay_id,
      };
      const recipients = [
        ...new Set(
          [
            invitation.sender_account_id,
            invitation.recipient_account_id,
            invitation.accepted_account_id,
          ].filter((id): id is string => !!id),
        ),
      ];
      for (const account_id of [
        ...new Set<string>([...recipients, ...(job.audience ?? [])]),
      ]) {
        const account = await getClusterAccountById(account_id);
        // Missing directory entries are not proof of deletion; retain the retry.
        if (!account?.home_bay_id) throw Error("recipient home unavailable");
        await peopleStorageClient(account.home_bay_id).applyAccessProjection({
          account_id,
          source_bay_id: route.bay_id,
          source_epoch: route.epoch,
          invitation,
          deleted: job.deleted || !recipients.includes(account_id),
          ...(account_id === invitation.sender_account_id &&
          email_ciphertext &&
          !job.deleted
            ? {
                contact_email: decryptSecretSettingValue(
                  "project_collab_invites.email",
                  email_ciphertext,
                  await getSecretSettingsKey(),
                ),
              }
            : {}),
        });
      }
      await pool.query(
        "UPDATE people_invite_outbox SET delivered_at=now(),lease_until=NULL WHERE invitation_id=$1 AND version=$2",
        [job.invitation_id, job.version],
      );
    } catch {
      await pool.query(
        `UPDATE people_invite_outbox SET lease_until=NULL,
        available_at=now()+LEAST(3600,POWER(2,LEAST(attempts,12))) * interval '1 second'
        WHERE invitation_id=$1 AND version=$2`,
        [job.invitation_id, job.version],
      );
      // Never log provider errors, ciphertext, addresses, messages or tokens.
      logger.warn("invitation projection delivery deferred", {
        invitation_id: job.invitation_id,
        version: `${job.version}`,
      });
    }
  }
  return jobs.length;
}
export async function runPeopleInviteMaintenance() {
  if (running) return;
  running = true;
  try {
    await ensureProjectCollabInviteEmailTokenSchema();
    await ensurePeopleSchema();
    await backfillPeopleInvites();
    await getPool()
      .query(`UPDATE project_collab_invites SET status='expired',updated=now(),responded=COALESCE(responded,now())
      WHERE invite_id IN (SELECT invite_id FROM project_collab_invites
        WHERE status='pending' AND created < now() - CASE WHEN invite_source IN ('email','course_email')
          THEN interval '14 days' ELSE interval '30 days' END ORDER BY created LIMIT 100 FOR UPDATE SKIP LOCKED)`);
    await drainPeopleInviteOutbox();
    await drainPeopleCollaborationOutbox();
    await purgeDeletedPeopleAccounts();
  } finally {
    running = false;
  }
}
