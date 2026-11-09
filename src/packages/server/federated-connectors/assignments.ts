/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Which federated connector grant an agent uses in a source project
(federated_connector_agent_grants), on the account's home bay. Every change
needs fresh authentication and, in one transaction:

- compares and swaps on the revision the user saw (a new assignment has
  none), bumping it on every change;
- writes the append-only audit row (./audit.ts);
- ends, with reason "revision", every open lease bound to this assignment,
  so no turn keeps using a grant it no longer has. The turn RPC also checks
  the binding on every renewal; ending here just doesn't wait for it.

The owner then gets a message naming no ids (best effort, after commit).
*/

import { randomUUID } from "node:crypto";
import getLogger from "@cocalc/backend/logger";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import {
  assertAccountHome,
  authorizeConfigChange,
} from "@cocalc/server/agents/cocalc-connector-config";
import { requireDangerousSessionAuth } from "@cocalc/server/conat/api/dangerous-session-auth";
import send from "@cocalc/server/messages/send";
import type { FederatedConnectorAssignment } from "@cocalc/util/ai/federated-connectors";
import { isValidUUID } from "@cocalc/util/misc";
import {
  recordFederatedAccessAudit,
  type FederatedAccessAuditAction,
} from "./audit";

const logger = getLogger("server:federated-connectors:assignments");

const TABLE = "federated_connector_agent_grants";
const LEASES = "federated_connector_turn_leases";

export type { FederatedConnectorAssignment };

const COLUMNS =
  "assignment_id,account_id,agent_id,source_project_id,grant_id,enabled,revision,created_at,updated_at";

function requireUuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !isValidUUID(value)) {
    throw Error(`invalid ${name}`);
  }
  return value;
}

function requireRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw Error("invalid assignment revision");
  }
  return value as number;
}

const CONFLICT = "gcloud settings changed; reload and try again";

function auditState(row: FederatedConnectorAssignment | undefined) {
  return row == null
    ? null
    : { grant_id: row.grant_id, enabled: row.enabled, revision: row.revision };
}

async function lockAssignment(
  client: PoolClient,
  account_id: string,
  agent_id: string,
  source_project_id: string,
): Promise<FederatedConnectorAssignment | undefined> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 7174))",
    [`${account_id}:${agent_id}:${source_project_id}`],
  );
  const { rows } = await client.query<FederatedConnectorAssignment>(
    `SELECT ${COLUMNS} FROM ${TABLE}
      WHERE account_id=$1 AND agent_id=$2 AND source_project_id=$3
      FOR UPDATE`,
    [account_id, agent_id, source_project_id],
  );
  return rows[0];
}

async function endLeases(
  client: PoolClient,
  assignment_id: string,
): Promise<void> {
  await client.query(
    `UPDATE ${LEASES} SET ended_at=clock_timestamp(), end_reason='revision'
      WHERE assignment_id=$1 AND ended_at IS NULL`,
    [assignment_id],
  );
}

async function inTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
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

const NOTICE_TEXT: Record<FederatedAccessAuditAction, string> = {
  assign: "was given",
  change: "now uses a different",
  disable: "was paused for its",
  enable: "was resumed for its",
  remove: "no longer has a",
  "shared-approve": "",
  "shared-revoke": "",
  "site-gate-change": "",
};

async function notifyOwner(
  account_id: string,
  action: FederatedAccessAuditAction,
): Promise<void> {
  try {
    await send({
      to_ids: [account_id],
      subject: "gcloud access for one of your agents changed",
      body: `One of your agents ${NOTICE_TEXT[action]} gcloud connection grant. If you didn't make this change, review your agents' connector settings and your account's sessions.`,
    });
  } catch (err) {
    logger.warn("owner notification failed", { action, err: `${err}` });
  }
}

export async function listFederatedConnectorAssignments({
  account_id,
}: {
  account_id?: string;
}): Promise<FederatedConnectorAssignment[]> {
  const owner = requireUuid(account_id, "account_id");
  await assertAccountHome(owner);
  const { rows } = await getPool().query<FederatedConnectorAssignment>(
    `SELECT ${COLUMNS} FROM ${TABLE} WHERE account_id=$1
      ORDER BY created_at`,
    [owner],
  );
  return rows;
}

/**
 * Assigns a grant to an agent in a source project, changes it, or turns it
 * on or off. Needs fresh authentication; giving or changing access also
 * needs the account to be a full collaborator of the project and the agent
 * to be its own.
 */
export async function saveFederatedConnectorAssignment({
  account_id,
  session_hash,
  agent_id,
  source_project_id,
  grant_id,
  enabled,
  expected_revision,
}: {
  account_id?: string;
  session_hash?: string;
  agent_id: string;
  source_project_id: string;
  grant_id: string;
  enabled: boolean;
  expected_revision?: number;
}): Promise<FederatedConnectorAssignment> {
  const owner = requireUuid(account_id, "account_id");
  requireUuid(agent_id, "agent_id");
  requireUuid(source_project_id, "source_project_id");
  requireUuid(grant_id, "grant_id");
  if (typeof enabled !== "boolean") throw Error("invalid assignment state");
  const expected =
    expected_revision === undefined
      ? undefined
      : requireRevision(expected_revision);
  const session = enabled
    ? await authorizeConfigChange({
        account_id: owner,
        session_hash,
        agent_id,
        source_project_id,
      })
    : await narrowingAuth(owner, session_hash);

  const { saved, action } = await inTransaction(async (client) => {
    const before = await lockAssignment(
      client,
      owner,
      agent_id,
      source_project_id,
    );
    if (
      expected === undefined ? before != null : before?.revision !== expected
    ) {
      throw Error(CONFLICT);
    }
    // The grant must be this account's; giving access needs it enabled.
    const { rows: grants } = await client.query<{ state: string }>(
      `SELECT state FROM federated_connector_grants
        WHERE grant_id=$1 AND account_id=$2 FOR SHARE`,
      [grant_id, owner],
    );
    if (!grants[0] || (enabled && grants[0].state !== "enabled")) {
      throw Error("gcloud grant is unavailable");
    }
    // Turning off (which skips the membership and agent checks) can only
    // turn off: it never moves the assignment to another grant.
    if (!enabled && before != null && before.grant_id !== grant_id) {
      throw Error("a disabled assignment can't change its grant");
    }
    let action: FederatedAccessAuditAction;
    if (before == null) {
      if (!enabled) throw Error("a new assignment must be enabled");
      action = "assign";
    } else if (before.grant_id !== grant_id) {
      action = "change";
    } else if (before.enabled !== enabled) {
      action = enabled ? "enable" : "disable";
    } else {
      throw Error("nothing to change");
    }
    const { rows } =
      before == null
        ? await client.query<FederatedConnectorAssignment>(
            `INSERT INTO ${TABLE}
               (assignment_id,account_id,agent_id,source_project_id,grant_id,
                enabled,revision,created_at,updated_at)
             VALUES ($1,$2,$3,$4,$5,true,1,now(),now())
             RETURNING ${COLUMNS}`,
            [randomUUID(), owner, agent_id, source_project_id, grant_id],
          )
        : await client.query<FederatedConnectorAssignment>(
            `UPDATE ${TABLE}
                SET grant_id=$2, enabled=$3, revision=revision+1, updated_at=now()
              WHERE assignment_id=$1
              RETURNING ${COLUMNS}`,
            [before.assignment_id, grant_id, enabled],
          );
    const saved = rows[0];
    await recordFederatedAccessAudit(client, {
      action,
      actor_account_id: owner,
      session,
      account_id: owner,
      agent_id,
      source_project_id,
      assignment_id: saved.assignment_id,
      before: auditState(before),
      after: auditState(saved),
    });
    if (before != null) await endLeases(client, before.assignment_id);
    return { saved, action };
  });
  await notifyOwner(owner, action);
  return saved;
}

/** Removes an assignment (fresh authentication, at the revision seen). */
export async function removeFederatedConnectorAssignment({
  account_id,
  session_hash,
  agent_id,
  source_project_id,
  expected_revision,
}: {
  account_id?: string;
  session_hash?: string;
  agent_id: string;
  source_project_id: string;
  expected_revision: number;
}): Promise<void> {
  const owner = requireUuid(account_id, "account_id");
  requireUuid(agent_id, "agent_id");
  requireUuid(source_project_id, "source_project_id");
  const expected = requireRevision(expected_revision);
  const session = await narrowingAuth(owner, session_hash);
  await inTransaction(async (client) => {
    const before = await lockAssignment(
      client,
      owner,
      agent_id,
      source_project_id,
    );
    if (before?.revision !== expected) throw Error(CONFLICT);
    await client.query(`DELETE FROM ${TABLE} WHERE assignment_id=$1`, [
      before.assignment_id,
    ]);
    await recordFederatedAccessAudit(client, {
      action: "remove",
      actor_account_id: owner,
      session,
      account_id: owner,
      agent_id,
      source_project_id,
      assignment_id: before.assignment_id,
      before: auditState(before),
      after: null,
    });
    await endLeases(client, before.assignment_id);
  });
  await notifyOwner(owner, "remove");
}

// Narrowing access (turning off, removing) still needs fresh authentication,
// so the audit records who did it, but not project membership: an account
// that left the project can still clean up its own assignment.
async function narrowingAuth(account_id: string, session_hash?: string) {
  await assertAccountHome(account_id);
  return await requireDangerousSessionAuth({
    account_id,
    session_hash,
    require_second_factor: true,
    allow_actor_impersonation: false,
  });
}
