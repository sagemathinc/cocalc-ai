/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import { uuid } from "./collaborators-common";

export async function bumpCollaborationRevision(
  db: Pick<PoolClient, "query">,
  account_id: string,
) {
  await db.query(
    `INSERT INTO collaboration_account_state(account_id,revision,revision_xid) VALUES($1,1,txid_current())
    ON CONFLICT(account_id) DO UPDATE SET revision=collaboration_account_state.revision+1,revision_xid=excluded.revision_xid
    WHERE collaboration_account_state.revision_xid IS DISTINCT FROM excluded.revision_xid`,
    [account_id],
  );
}
/** Captured BEFORE the page query: a concurrent commit is observed by check. */
export async function checkCollaborationRevision(
  account_id: string,
  since?: string,
) {
  uuid(account_id, "account_id");
  const row = (
    await getPool().query(
      `SELECT COALESCE((SELECT revision FROM collaboration_account_state WHERE account_id=$1),0)::text AS revision,
    (SELECT min(lease_until) FROM collaboration_access WHERE account_id=$1 AND lease_until>now()) AS expires`,
      [account_id],
    )
  ).rows[0];
  const expires = Math.min(
    Date.now() + 30000,
    row.expires ? new Date(row.expires).getTime() : Infinity,
  );
  const current = { v: 1, account_id, revision: row.revision, expires };
  let reset = true;
  if (typeof since === "string" && since.length <= 1024) {
    try {
      const old = JSON.parse(Buffer.from(since, "base64url").toString());
      reset =
        old.v !== 1 ||
        old.account_id !== account_id ||
        old.revision !== row.revision ||
        !Number.isFinite(old.expires) ||
        old.expires <= Date.now();
    } catch {
      /* Malformed/expired tokens request a bounded fresh page. */
    }
  }
  return {
    revision: Buffer.from(JSON.stringify(current)).toString("base64url"),
    reset,
    poll_after_ms: 5000,
  };
}
