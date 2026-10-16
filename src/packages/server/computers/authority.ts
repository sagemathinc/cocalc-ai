/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Every transaction that writes computer state starts here: it takes the
// canonical account-rehome fence (the advisory lock rehome itself takes) and
// requires this bay to be the account's home. A rehome therefore either
// sees the rows this transaction writes, or this transaction sees the rehome
// and refuses. It is the first lock.

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
