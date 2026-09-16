/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { accountBanTimestampSchemaReady } from "@cocalc/database/postgres/schema/account-ban-timestamp";

let schemaReady: Promise<void> | undefined;

// Request paths must never attempt DDL on accounts: a queued exclusive lock
// blocks authentication reads. Installation belongs to database schema sync.
export async function ensureAccountBanTimestampSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const pool = getPool();
    if (!(await accountBanTimestampSchemaReady(pool))) {
      throw new Error(
        "account ban timestamp schema is not installed; run database schema sync",
      );
    }
  })().catch((err) => {
    schemaReady = undefined;
    throw err;
  });
  await schemaReady;
}

export function resetAccountBanTimestampSchemaForTests(): void {
  schemaReady = undefined;
}
