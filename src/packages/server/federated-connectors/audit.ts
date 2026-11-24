/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The append-only audit of federated connector access changes
(federated_connector_assignment_audit): assignments, shared-project
approvals and the site gate. Each row is written in the same transaction as
the change it records, so no change is applied without its record.

Rows stay on the bay where they were written (the account's home bay, the
project's owning bay, or the seed bay for the site gate); a rehome doesn't
move them. An access review must therefore read this table on every bay.

The session is recorded as a keyed hash: HMAC-SHA256 of the session's hash
under a key derived from the site master key. It links rows from the same
session, but can't be used to confirm a session token or cookie. Rotating
the site master key only stops older rows linking to newer ones.
*/

import { createHmac, randomUUID } from "node:crypto";
import { secrets } from "@cocalc/backend/data";
import type { PoolClient } from "@cocalc/database/pool";
import {
  deriveSiteMasterKeyring,
  getSiteMasterKeyring,
} from "@cocalc/util/master-key-lifecycle";
import type { AccountAuthSessionRow } from "@cocalc/server/auth/auth-sessions";

export const FEDERATED_ACCESS_AUDIT_TABLE =
  "federated_connector_assignment_audit";

export type FederatedAccessAuditAction =
  | "assign"
  | "change"
  | "disable"
  | "enable"
  | "remove"
  | "shared-approve"
  | "shared-revoke"
  | "site-gate-change"
  | "broker-signer-change"
  | "issuer-pin-change";

let sessionKey: Buffer | undefined;

async function getSessionKey(): Promise<Buffer> {
  if (sessionKey == null) {
    const active = deriveSiteMasterKeyring(
      await getSiteMasterKeyring({ secretsDir: secrets }),
      "federated-audit-session:v1",
    ).find(({ role }) => role === "active");
    if (active == null) throw Error("no active site master key");
    sessionKey = active.key;
  }
  return sessionKey;
}

export function setFederatedAuditSessionKeyForTesting(key?: Buffer): void {
  sessionKey = key;
}

/** Keyed hash of a session's hash; never stores the session itself. */
export async function federatedAuditSessionHash(
  session_hash: string,
): Promise<string> {
  return createHmac("sha256", await getSessionKey())
    .update(`session:${session_hash}`)
    .digest("hex");
}

/** When the session last completed fresh authentication. */
export function freshAuthAt(session: AccountAuthSessionRow): Date | null {
  return (
    session.factor_verified_at ??
    session.primary_verified_at ??
    session.authenticated_at ??
    null
  );
}

export interface FederatedAccessAuditRow {
  action: FederatedAccessAuditAction;
  actor_account_id: string;
  session: AccountAuthSessionRow;
  account_id?: string | null;
  agent_id?: string | null;
  source_project_id?: string | null;
  assignment_id?: string | null;
  approval_id?: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/** Writes one audit row in the caller's transaction (time: database clock). */
export async function recordFederatedAccessAudit(
  db: Pick<PoolClient, "query">,
  row: FederatedAccessAuditRow,
): Promise<void> {
  await db.query(
    `INSERT INTO ${FEDERATED_ACCESS_AUDIT_TABLE}
       (id, action, actor_account_id, session_hash, fresh_auth_at, account_id,
        agent_id, source_project_id, assignment_id, approval_id, before, after)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      randomUUID(),
      row.action,
      row.actor_account_id,
      await federatedAuditSessionHash(row.session.session_hash),
      freshAuthAt(row.session),
      row.account_id ?? null,
      row.agent_id ?? null,
      row.source_project_id ?? null,
      row.assignment_id ?? null,
      row.approval_id ?? null,
      row.before,
      row.after,
    ],
  );
}
