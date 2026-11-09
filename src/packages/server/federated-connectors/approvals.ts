/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Project owners' shared-project approvals for federated connectors
(federated_connector_shared_project_approvals), and the project snapshot
the turn RPC and the broker read before every renewal and mint. Both are
authoritative only on the project's owning bay: every function here refuses
unless this bay owns the project, and reads membership in the same
transaction. Database triggers
(database/postgres/schema/federated-connector-guards.ts) keep each
approval's binding fixed and let it be revoked exactly once.

An approval counts only while its approver is still an owner of the
project. Project rehome doesn't copy approvals, and ends the ones left on
the source bay when ownership moves, so a project that returns to a bay needs
a new approval.
*/

import { randomUUID } from "node:crypto";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { requireDangerousSessionAuth } from "@cocalc/server/conat/api/dangerous-session-auth";
import { isValidUUID } from "@cocalc/util/misc";
import { SHARED_PROJECT_APPROVALS_TABLE } from "./approvals-rehome";
import { recordFederatedAccessAudit } from "./audit";

export {
  revokeFederatedSharedProjectApprovalsForRehome,
  SHARED_PROJECT_APPROVALS_TABLE,
} from "./approvals-rehome";

function requireUuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !isValidUUID(value)) {
    throw Error(`invalid ${name}`);
  }
  return value;
}

function roleOf(users: Record<string, any>, account_id: string): string | null {
  const member = users?.[account_id];
  if (member == null) return null;
  const group = typeof member === "string" ? member : member?.group;
  return typeof group === "string" ? group : "unknown";
}

interface LocalProject {
  users: Record<string, any>;
  users_revision: number;
}

/**
 * Loads and locks the project row, refusing unless this bay owns it. The
 * share lock holds membership changes until the caller's transaction ends.
 */
async function lockLocalProject(
  client: PoolClient,
  project_id: string,
): Promise<LocalProject> {
  const { rows } = await client.query<{
    users: Record<string, any> | null;
    users_revision: string | number | null;
    owning_bay_id: string;
  }>(
    `SELECT users, COALESCE(runtime_authority_revision, 0) AS users_revision,
            COALESCE(owning_bay_id, $2) AS owning_bay_id
       FROM projects
      WHERE project_id=$1 AND deleted IS NOT TRUE
      FOR SHARE`,
    [project_id, getConfiguredBayId()],
  );
  const row = rows[0];
  if (row == null || row.owning_bay_id !== getConfiguredBayId()) {
    throw Error("project is not owned by this bay");
  }
  return {
    users: row.users ?? {},
    users_revision: Number(row.users_revision ?? 0),
  };
}

async function inTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  readOnly = false,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query(
      readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN",
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function freshSession(account_id: string, session_hash?: string) {
  return await requireDangerousSessionAuth({
    account_id,
    session_hash,
    require_second_factor: true,
    allow_actor_impersonation: false,
  });
}

/**
 * A current owner of the project (with fresh authentication) approves one
 * full collaborator's federated credentials being used in the project while
 * it has other members. Runs on the project's owning bay.
 */
export async function approveFederatedSharedProjectOnOwningBay({
  account_id: actor,
  session_hash,
  project_id,
  approved_account_id,
}: {
  account_id?: string;
  session_hash?: string;
  project_id: string;
  approved_account_id: string;
}): Promise<{ approval_id: string }> {
  const owner = requireUuid(actor, "account_id");
  requireUuid(project_id, "project_id");
  requireUuid(approved_account_id, "approved_account_id");
  const session = await freshSession(owner, session_hash);
  return await inTransaction(async (client) => {
    const { users } = await lockLocalProject(client, project_id);
    if (roleOf(users, owner) !== "owner") {
      throw Error("only a project owner can approve this");
    }
    const role = roleOf(users, approved_account_id);
    if (role !== "owner" && role !== "collaborator") {
      throw Error("the account is not a collaborator of this project");
    }
    const approval_id = randomUUID();
    const { rowCount } = await client.query(
      `INSERT INTO ${SHARED_PROJECT_APPROVALS_TABLE}
         (approval_id, project_id, account_id, approver_account_id)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT DO NOTHING`,
      [approval_id, project_id, approved_account_id, owner],
    );
    if (!rowCount) throw Error("already approved");
    await recordFederatedAccessAudit(client, {
      action: "shared-approve",
      actor_account_id: owner,
      session,
      account_id: approved_account_id,
      source_project_id: project_id,
      approval_id,
      before: null,
      after: { approver_account_id: owner },
    });
    return { approval_id };
  });
}

/**
 * Revokes the active approval for an account in a project. A current owner
 * may revoke it, and so may the approved account itself (it only narrows
 * that account's own access). Fresh authentication; on the owning bay.
 */
export async function revokeFederatedSharedProjectOnOwningBay({
  account_id: actor,
  session_hash,
  project_id,
  approved_account_id,
}: {
  account_id?: string;
  session_hash?: string;
  project_id: string;
  approved_account_id: string;
}): Promise<void> {
  const who = requireUuid(actor, "account_id");
  requireUuid(project_id, "project_id");
  requireUuid(approved_account_id, "approved_account_id");
  const session = await freshSession(who, session_hash);
  await inTransaction(async (client) => {
    const { users } = await lockLocalProject(client, project_id);
    if (roleOf(users, who) !== "owner" && who !== approved_account_id) {
      throw Error("only a project owner can revoke this");
    }
    const { rows } = await client.query<{
      approval_id: string;
      approver_account_id: string;
    }>(
      `UPDATE ${SHARED_PROJECT_APPROVALS_TABLE}
          SET revoked_at=clock_timestamp(), revoked_by=$3, revoke_reason=$4
        WHERE project_id=$1 AND account_id=$2 AND revoked_at IS NULL
        RETURNING approval_id, approver_account_id`,
      [
        project_id,
        approved_account_id,
        who,
        who === approved_account_id ? "self" : "owner",
      ],
    );
    if (!rows[0]) throw Error("no active approval");
    await recordFederatedAccessAudit(client, {
      action: "shared-revoke",
      actor_account_id: who,
      session,
      account_id: approved_account_id,
      source_project_id: project_id,
      approval_id: rows[0].approval_id,
      before: { approver_account_id: rows[0].approver_account_id },
      after: { reason: who === approved_account_id ? "self" : "owner" },
    });
  });
}

/**
 * What the single-user project gate needs, read on the owning bay in one
 * read-only transaction. Counts only: never other members' ids.
 */
export interface FederationProjectSnapshot {
  owning_bay_id: string;
  users_revision: number;
  /** The connector account's role, or null if it isn't a member. */
  account_role: string | null;
  /** Members other than the account, in any role. */
  other_members: number;
  /** Invitations that could be accepted without any owner action. */
  pending_invites: number;
  /** The active approval, only while its approver is still an owner. */
  approval_id: string | null;
}

export function isSharedProject(snapshot: FederationProjectSnapshot): boolean {
  return snapshot.other_members > 0 || snapshot.pending_invites > 0;
}

export async function federationSnapshotOnOwningBay({
  project_id,
  account_id,
}: {
  project_id: string;
  account_id: string;
}): Promise<FederationProjectSnapshot> {
  requireUuid(project_id, "project_id");
  requireUuid(account_id, "account_id");
  return await inTransaction(async (client) => {
    const { rows } = await client.query<{
      users: Record<string, any> | null;
      users_revision: string | number | null;
      owning_bay_id: string;
    }>(
      `SELECT users, COALESCE(runtime_authority_revision, 0) AS users_revision,
              COALESCE(owning_bay_id, $2) AS owning_bay_id
         FROM projects
        WHERE project_id=$1 AND deleted IS NOT TRUE`,
      [project_id, getConfiguredBayId()],
    );
    const project = rows[0];
    if (project == null || project.owning_bay_id !== getConfiguredBayId()) {
      throw Error("project is not owned by this bay");
    }
    const users = project.users ?? {};
    const { rows: invites } = await client.query<{ count: string }>(
      `SELECT count(*) FROM project_collab_invites
        WHERE project_id=$1 AND status='pending'`,
      [project_id],
    );
    const { rows: approvals } = await client.query<{
      approval_id: string;
      approver_account_id: string;
    }>(
      `SELECT approval_id, approver_account_id
         FROM ${SHARED_PROJECT_APPROVALS_TABLE}
        WHERE project_id=$1 AND account_id=$2 AND revoked_at IS NULL`,
      [project_id, account_id],
    );
    const approval = approvals[0];
    return {
      owning_bay_id: project.owning_bay_id,
      users_revision: Number(project.users_revision ?? 0),
      account_role: roleOf(users, account_id),
      other_members: Object.keys(users).filter((id) => id !== account_id)
        .length,
      pending_invites: Number(invites[0]?.count ?? 0),
      approval_id:
        approval != null &&
        roleOf(users, approval.approver_account_id) === "owner"
          ? approval.approval_id
          : null,
    };
  }, true);
}
