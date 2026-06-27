/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import * as LS from "@cocalc/frontend/misc/local-storage-typed";

const REQUEST_KEY_PREFIX = "legacy-billing-migration-review-requested";
const REQUEST_TTL_MS = 5 * 60 * 1000;

function key(account_id: string): string[] {
  return [REQUEST_KEY_PREFIX, account_id];
}

export function markLegacyBillingMigrationReviewRequested(
  account_id: string,
): void {
  LS.set(key(account_id), Date.now());
}

export function legacyBillingMigrationReviewRequested(
  account_id: string | undefined,
): boolean {
  if (!account_id) return false;
  const requestedAt = LS.get<number>(key(account_id));
  if (typeof requestedAt !== "number") return false;
  if (Date.now() > requestedAt + REQUEST_TTL_MS) {
    LS.del(key(account_id));
    return false;
  }
  return true;
}
