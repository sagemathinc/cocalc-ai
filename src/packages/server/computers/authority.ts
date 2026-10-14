/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Every transaction that writes computer state starts here: it takes the
// canonical account-rehome fence (the advisory lock rehome itself takes) and
// requires this bay to be the account's home. A rehome therefore either
// sees the rows this transaction writes, or this transaction sees the rehome
// and refuses. It is the first lock, before controls, network and computer,
// matching PersonalAgentStore.locked.

import {
  assertAccountNotRehoming,
  assertAccountWriteOnHomeBay,
} from "@cocalc/server/accounts/rehome-fence";

export interface Queryable {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export async function assertComputersAuthority(
  db: Queryable,
  account_id: string,
  action = "use computers",
): Promise<void> {
  await assertAccountNotRehoming({ db: db as any, account_id, action });
  await assertAccountWriteOnHomeBay({ db: db as any, account_id, action });
}

/**
 * Lock (and create if missing) the account's agent messaging controls row,
 * so a first-time pause serializes with whatever this transaction checks.
 * Returns whether agent messaging is paused.
 */
export async function lockAgentControls(
  db: Queryable,
  account_id: string,
  mode: "share" | "update" = "share",
): Promise<{ paused: boolean }> {
  await db.query(
    "INSERT INTO agent_personal_controls(account_id) VALUES($1) ON CONFLICT DO NOTHING",
    [account_id],
  );
  const { rows } = await db.query(
    `SELECT paused FROM agent_personal_controls WHERE account_id=$1 FOR ${
      mode === "share" ? "SHARE" : "UPDATE"
    }`,
    [account_id],
  );
  return { paused: rows[0]?.paused === true };
}
