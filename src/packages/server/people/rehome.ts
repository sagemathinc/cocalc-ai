/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { PeopleDb } from "./schema";

/** These guards run under the existing rehome advisory transaction fences. */
export async function assertNoPeopleAccountStateForRehome(
  db: PeopleDb,
  account_id: string,
) {
  for (const table of [
    "people_contacts",
    "people_invitation_index",
    "people_account_state",
    "people_collaboration_outbox",
    "people_invitation_drafts",
    "people_invitation_operations",
  ]) {
    if (
      !(await db.query("SELECT to_regclass($1) AS name", [`public.${table}`]))
        .rows[0]?.name
    )
      continue;
    if (
      (
        await db.query(`SELECT 1 FROM ${table} WHERE account_id=$1 LIMIT 1`, [
          account_id,
        ])
      ).rows.length
    )
      throw Error(
        "Account rehome is unavailable while private people contacts or invitation projections exist; people state portability is not supported yet",
      );
  }
}
export async function assertNoPeopleProjectStateForRehome(
  db: PeopleDb,
  project_id: string,
) {
  for (const table of [
    "people_invite_outbox",
    "people_invitation_action_receipts",
    "people_invite_resend_operations",
    "collaboration_scan_jobs",
    "collaboration_scan_receipts",
    "collaboration_scan_budget",
  ]) {
    if (
      !(await db.query("SELECT to_regclass($1) AS name", [`public.${table}`]))
        .rows[0]?.name
    )
      continue;
    if (
      (
        await db.query(`SELECT 1 FROM ${table} WHERE project_id=$1 LIMIT 1`, [
          project_id,
        ])
      ).rows.length
    )
      throw Error(
        "Project rehome is unavailable while people invitation lifecycle, scan jobs, or receipt state exists; portability is not supported yet",
      );
    if (
      table === "people_invite_outbox" &&
      (
        await db.query(
          "SELECT 1 FROM project_collab_invites WHERE project_id=$1 LIMIT 1",
          [project_id],
        )
      ).rows.length
    )
      throw Error(
        "Project rehome is unavailable until existing people invitations have portable lifecycle state",
      );
  }
}
/** Account deletion purges private ciphertext; retained invitation evidence in
 * other owners' namespaces is not rewritten or interpreted as identity proof.
 */
export async function purgeDeletedPeopleAccounts(limit = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw Error("invalid deletion limit");
  const { default: getPool } = await import("@cocalc/database/pool");
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    const tables: string[] = [];
    for (const table of [
      "people_contacts",
      "people_invitation_index",
      "people_account_state",
      "people_collaboration_outbox",
      "people_invitation_drafts",
      "people_invitation_operations",
    ]) {
      if (
        (await db.query("SELECT to_regclass($1) AS name", [`public.${table}`]))
          .rows[0]?.name
      )
        tables.push(table);
    }
    if (!tables.length) {
      await db.query("COMMIT");
      return 0;
    }
    const rows = (
      await db.query(
        `SELECT a.account_id FROM accounts a WHERE a.deleted IS TRUE AND
          (${tables.map((table) => `EXISTS(SELECT 1 FROM ${table} s WHERE s.account_id=a.account_id)`).join(" OR ")})
          ORDER BY a.account_id LIMIT $1 FOR UPDATE OF a SKIP LOCKED`,
        [limit],
      )
    ).rows;
    const ids = rows.map((r) => r.account_id);
    for (const table of tables) {
      await db.query(`DELETE FROM ${table} WHERE account_id=ANY($1::uuid[])`, [
        ids,
      ]);
    }
    await db.query("COMMIT");
    return ids.length;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}
