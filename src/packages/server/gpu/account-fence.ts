/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// The account fence GPU launches and key changes share: the account rehome
// advisory lock (first in the GPU lock order), then, under it on the same
// transaction, the authoritative checks that the account isn't being
// rehomed and is still homed on this bay. A check made before waiting for
// the lock could be stale by the time it is held.

import type { PoolClient } from "@cocalc/database/pool";
import {
  assertAccountNotRehoming,
  assertAccountWriteOnHomeBay,
} from "@cocalc/server/accounts/rehome-fence";

export async function lockGpuAccountFence(
  db: Pick<PoolClient, "query">,
  account_id: string,
  action: string,
): Promise<void> {
  // takes the lock, then refuses during a rehome
  await assertAccountNotRehoming({ db: db as any, account_id, action });
  await assertAccountWriteOnHomeBay({ db: db as any, account_id, action });
}
