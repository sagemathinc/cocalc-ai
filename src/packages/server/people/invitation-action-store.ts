/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { createHmac } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { getSecretSettingsKey } from "@cocalc/database/settings/secret-settings";
import { withProjectRehomeWriteFence } from "@cocalc/database/postgres/project-rehome-fence";
import type { PeopleAccessInput } from "@cocalc/conat/inter-bay/people-actions";
import type { PeopleInvitationActionReceipt } from "@cocalc/util/people-invitations";

let ready: Promise<void> | undefined;
export async function ensurePeopleActionSchema() {
  if (!ready)
    ready = (async () => {
      await getPool().query(
        `
    CREATE TABLE IF NOT EXISTS people_invitation_action_receipts (
      account_id UUID NOT NULL,
      child_operation_id UUID NOT NULL,
      project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
      payload_hash TEXT NOT NULL,
      receipt JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(account_id,child_operation_id)
    );
  `,
      );
      await getPool()
        .query(`CREATE INDEX IF NOT EXISTS people_invitation_action_project_idx
        ON people_invitation_action_receipts(project_id)`);
    })().catch((err) => {
      ready = undefined;
      throw err;
    });
  return ready;
}

// Keyed, not a dictionary-attackable digest of a private email specification.
export async function peopleActionBinding(input: PeopleAccessInput) {
  return createHmac("sha256", await getSecretSettingsKey())
    .update("people-invitation-action:v1\0")
    .update(
      JSON.stringify([
        input.account_id,
        input.child_operation_id,
        input.payload,
        input.action,
      ]),
    )
    .digest("hex");
}
export function unknownPeopleAction(
  input: PeopleAccessInput,
): PeopleInvitationActionReceipt {
  return {
    child_operation_id: input.child_operation_id,
    project_id: input.action.project_id,
    action: input.action.action,
    status: "unknown",
    delivery: [],
    reason: "owner_execution_unknown",
  };
}
export async function readPeopleAction(
  input: PeopleAccessInput,
  binding: string,
) {
  await ensurePeopleActionSchema();
  const row = (
    await getPool().query(
      `SELECT payload_hash,receipt FROM people_invitation_action_receipts WHERE account_id=$1 AND child_operation_id=$2`,
      [input.account_id, input.child_operation_id],
    )
  ).rows[0];
  if (!row) return undefined;
  if (row.payload_hash !== binding)
    throw Error("invitation child operation payload mismatch");
  return row.receipt as PeopleInvitationActionReceipt;
}

/** Commit uncertainty BEFORE invoking legacy code with independent transactions/SMTP.
 * A losing caller must inspect, never call that code a second time.
 */
export async function claimPeopleAction(
  input: PeopleAccessInput,
  binding: string,
  checkOwner: () => Promise<void>,
) {
  await ensurePeopleActionSchema();
  return withProjectRehomeWriteFence({
    project_id: input.action.project_id,
    action: "admit people invitation",
    fn: async (db) => {
      await checkOwner();
      const result = await db.query(
        `INSERT INTO people_invitation_action_receipts
        (account_id,child_operation_id,project_id,payload_hash,receipt) VALUES($1,$2,$3,$4,$5::jsonb)
        ON CONFLICT(account_id,child_operation_id) DO NOTHING RETURNING child_operation_id`,
        [
          input.account_id,
          input.child_operation_id,
          input.action.project_id,
          binding,
          JSON.stringify(unknownPeopleAction(input)),
        ],
      );
      return result.rows.length === 1;
    },
  });
}
export async function finishPeopleAction(
  input: PeopleAccessInput,
  binding: string,
  receipt: PeopleInvitationActionReceipt,
) {
  const result = await getPool().query(
    `UPDATE people_invitation_action_receipts SET receipt=$4::jsonb,updated_at=now()
    WHERE account_id=$1 AND child_operation_id=$2 AND payload_hash=$3 RETURNING child_operation_id`,
    [
      input.account_id,
      input.child_operation_id,
      binding,
      JSON.stringify(receipt),
    ],
  );
  if (!result.rows.length)
    throw Error("invitation receipt no longer available");
  return receipt;
}

/** Inspection may recover an access insert, but must not overwrite a concurrent
 * successful SMTP receipt from the original execution.
 */
export async function recoverPeopleAction(
  input: PeopleAccessInput,
  binding: string,
  receipt: PeopleInvitationActionReceipt,
  db: { query(sql: string, values?: any[]): Promise<{ rows: any[] }> },
): Promise<PeopleInvitationActionReceipt> {
  const row = (
    await db.query(
      `UPDATE people_invitation_action_receipts
    SET receipt=CASE WHEN receipt->>'status'='unknown' THEN $4::jsonb ELSE receipt END,
        updated_at=now()
    WHERE account_id=$1 AND child_operation_id=$2 AND payload_hash=$3 RETURNING receipt`,
      [
        input.account_id,
        input.child_operation_id,
        binding,
        JSON.stringify(receipt),
      ],
    )
  ).rows[0];
  if (!row) throw Error("invitation receipt no longer available");
  return row.receipt;
}
