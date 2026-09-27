/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import {
  sourceKey,
  transaction,
  uuid,
  validateSource,
} from "./collaborators-common";
import {
  assertCollaborationAccountAuthority,
  type CollaborationOwnerAuthority,
} from "./collaborators-owner";

/** Request one known source; never scan files, start compute, or adopt its room. */
export async function requestCollaborationSource(
  input: { account_id: string; project_id: string; chat_path: string },
  authority: CollaborationOwnerAuthority,
): Promise<{ requested: true }> {
  const source = validateSource(input);
  uuid(input.account_id, "account_id");
  return transaction(async (db) => {
    // This locks the owning project, serializing capacity checks and revocation.
    await assertCollaborationAccountAuthority(
      db,
      source.project_id,
      input.account_id,
      authority,
    );
    const existing = (
      await db.query(
        "SELECT relocated_to FROM collaboration_sources WHERE source_id=$1",
        [sourceKey(source)],
      )
    ).rows[0];
    if (existing?.relocated_to)
      throw Error("source has moved; request its current location");
    if (existing) return { requested: true };
    const pending = await db.query(
      "SELECT 1 FROM collaboration_source_requests WHERE project_id=$1 AND chat_path=$2",
      [source.project_id, source.chat_path],
    );
    if (pending.rows.length) return { requested: true };
    const budget = (
      await db.query(
        `SELECT (SELECT count(*) FROM collaboration_sources WHERE project_id=$1) +
        (SELECT count(*) FROM collaboration_source_requests WHERE project_id=$1) AS n`,
        [source.project_id],
      )
    ).rows[0];
    if (Number(budget.n) >= 1024)
      throw Error("collaboration source capacity reached");
    await db.query(
      `INSERT INTO collaboration_source_requests(project_id,chat_path,requested_by)
       VALUES($1,$2,$3)`,
      [source.project_id, source.chat_path, input.account_id],
    );
    return { requested: true };
  });
}
