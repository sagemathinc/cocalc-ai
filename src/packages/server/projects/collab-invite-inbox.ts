/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  ProjectCollabInviteAction,
  ProjectCollabInviteRow,
  ProjectCollabInviteStatus,
} from "@cocalc/conat/hub/api/projects";
import {
  createInterBayProjectCollabInviteClient,
  type ProjectCollabInviteWire,
} from "@cocalc/conat/inter-bay/api";
import getPool from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";

const TABLE = "project_collab_invite_inbox";

export interface ProjectedCollabInviteEnvelope {
  source_bay_id: string;
  invite: ProjectCollabInviteRow;
}

function asDate(value: unknown): Date | undefined | null {
  if (value == null || value === "") {
    return value as null | undefined;
  }
  return value instanceof Date ? value : new Date(`${value}`);
}

export function toWire(
  invite: ProjectCollabInviteRow,
): ProjectCollabInviteWire {
  return {
    ...invite,
    created: new Date(invite.created).toISOString(),
    updated: new Date(invite.updated).toISOString(),
    responded: invite.responded
      ? new Date(invite.responded).toISOString()
      : null,
    expires: invite.expires ? new Date(invite.expires).toISOString() : null,
  };
}

export function fromWire(
  invite: ProjectCollabInviteWire,
): ProjectCollabInviteRow {
  return {
    ...invite,
    created: new Date(invite.created),
    updated: new Date(invite.updated),
    responded: asDate(invite.responded),
    expires: asDate(invite.expires),
  };
}

export async function ensureProjectCollabInviteInboxSchema(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      invite_id UUID PRIMARY KEY,
      source_bay_id VARCHAR(64) NOT NULL,
      project_id UUID NOT NULL,
      project_title TEXT,
      project_description TEXT,
      inviter_account_id UUID NOT NULL,
      invitee_account_id UUID NOT NULL,
      message TEXT,
      status VARCHAR(32) NOT NULL,
      responder_action VARCHAR(32),
      created TIMESTAMP NOT NULL,
      updated TIMESTAMP NOT NULL,
      responded TIMESTAMP,
      expires TIMESTAMP
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_invitee_idx ON ${TABLE} (invitee_account_id, created DESC)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_project_idx ON ${TABLE} (project_id, created DESC)`,
  );
}

export async function upsertProjectedCollabInviteDirect({
  source_bay_id,
  invite,
}: {
  source_bay_id: string;
  invite: ProjectCollabInviteWire;
}): Promise<void> {
  if (!invite.invitee_account_id) {
    return;
  }
  await ensureProjectCollabInviteInboxSchema();
  await getPool().query(
    `INSERT INTO ${TABLE}
      (invite_id, source_bay_id, project_id, project_title, project_description,
       inviter_account_id, invitee_account_id, message, status, responder_action,
       created, updated, responded, expires)
     VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (invite_id)
     DO UPDATE SET
       source_bay_id=EXCLUDED.source_bay_id,
       project_id=EXCLUDED.project_id,
       project_title=EXCLUDED.project_title,
       project_description=EXCLUDED.project_description,
       inviter_account_id=EXCLUDED.inviter_account_id,
       invitee_account_id=EXCLUDED.invitee_account_id,
       message=EXCLUDED.message,
       status=EXCLUDED.status,
       responder_action=EXCLUDED.responder_action,
       created=EXCLUDED.created,
       updated=EXCLUDED.updated,
       responded=EXCLUDED.responded,
       expires=EXCLUDED.expires`,
    [
      invite.invite_id,
      source_bay_id,
      invite.project_id,
      invite.project_title ?? null,
      invite.project_description ?? null,
      invite.inviter_account_id,
      invite.invitee_account_id,
      invite.message ?? null,
      invite.status,
      invite.responder_action ?? null,
      invite.created,
      invite.updated,
      invite.responded ?? null,
      invite.expires ?? null,
    ],
  );
}

export async function deleteProjectedCollabInviteDirect(
  invite_id: string,
): Promise<void> {
  await ensureProjectCollabInviteInboxSchema();
  await getPool().query(`DELETE FROM ${TABLE} WHERE invite_id=$1`, [invite_id]);
}

export async function listProjectedInboundCollabInvites({
  account_id,
  project_id,
  status,
  limit,
}: {
  account_id: string;
  project_id?: string;
  status?: ProjectCollabInviteStatus;
  limit: number;
}): Promise<ProjectCollabInviteRow[]> {
  if (status != null && status !== "pending") {
    return [];
  }
  await ensureProjectCollabInviteInboxSchema();
  const params: any[] = [account_id];
  const where = [`invitee_account_id=$1`];
  if (project_id) {
    params.push(project_id);
    where.push(`project_id=$${params.length}`);
  }
  params.push(limit);
  const { rows } = await getPool().query(
    `SELECT invite_id, project_id, project_title, project_description,
            inviter_account_id, invitee_account_id, message, status,
            responder_action, created, updated, responded, expires
       FROM ${TABLE}
      WHERE ${where.join(" AND ")}
      ORDER BY created DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map((row) => ({
    ...row,
    invite_source: "account" as const,
    shared_projects_count: 0,
    shared_projects_sample: [],
    prior_invites_accepted: 0,
    prior_invites_declined: 0,
  }));
}

export async function getProjectedInboundCollabInvite({
  account_id,
  invite_id,
}: {
  account_id: string;
  invite_id: string;
}): Promise<ProjectedCollabInviteEnvelope | undefined> {
  await ensureProjectCollabInviteInboxSchema();
  const { rows } = await getPool().query(
    `SELECT source_bay_id, invite_id, project_id, project_title, project_description,
            inviter_account_id, invitee_account_id, message, status,
            responder_action, created, updated, responded, expires
       FROM ${TABLE}
      WHERE invite_id=$1
        AND invitee_account_id=$2
      LIMIT 1`,
    [invite_id, account_id],
  );
  const row = rows[0];
  if (!row) {
    return;
  }
  return {
    source_bay_id: row.source_bay_id,
    invite: {
      ...row,
      invite_source: "account",
      shared_projects_count: 0,
      shared_projects_sample: [],
      prior_invites_accepted: 0,
      prior_invites_declined: 0,
    },
  };
}

export async function syncProjectedInboundCollabInvite({
  source_bay_id,
  invite,
  invitee_home_bay_id,
}: {
  source_bay_id: string;
  invite: ProjectCollabInviteRow;
  invitee_home_bay_id?: string | null;
}): Promise<void> {
  if (!invite.invitee_account_id) {
    return;
  }
  const homeBay = `${invitee_home_bay_id ?? ""}`.trim();
  if (
    !homeBay ||
    homeBay === source_bay_id ||
    homeBay === getConfiguredBayId()
  ) {
    return;
  }
  await createInterBayProjectCollabInviteClient({
    client: getInterBayFabricClient(),
    dest_bay: homeBay,
  }).upsertInbox({
    source_bay_id,
    invite: toWire(invite),
  });
}

export async function deleteProjectedInboundCollabInvite({
  invite_id,
  invitee_account_id,
  invitee_home_bay_id,
}: {
  invite_id: string;
  invitee_account_id?: string | null;
  invitee_home_bay_id?: string | null;
}): Promise<void> {
  const homeBay =
    `${invitee_home_bay_id ?? ""}`.trim() ||
    `${
      (invitee_account_id
        ? (await getClusterAccountById(invitee_account_id))?.home_bay_id
        : "") ?? ""
    }`.trim();
  if (!homeBay || homeBay === getConfiguredBayId()) {
    return;
  }
  await createInterBayProjectCollabInviteClient({
    client: getInterBayFabricClient(),
    dest_bay: homeBay,
  }).deleteInbox({ invite_id });
}

export async function respondProjectedInboundCollabInvite({
  account_id,
  invite_id,
  action,
  includeEmail,
}: {
  account_id: string;
  invite_id: string;
  action: ProjectCollabInviteAction;
  includeEmail: boolean;
}): Promise<ProjectCollabInviteRow | null> {
  const projected = await getProjectedInboundCollabInvite({
    account_id,
    invite_id,
  });
  if (!projected) {
    return null;
  }
  const result = await createInterBayProjectCollabInviteClient({
    client: getInterBayFabricClient(),
    dest_bay: projected.source_bay_id,
  }).respond({
    invite_id,
    account_id,
    action,
    include_email: includeEmail,
  });
  await deleteProjectedCollabInviteDirect(invite_id);
  return fromWire(result);
}
