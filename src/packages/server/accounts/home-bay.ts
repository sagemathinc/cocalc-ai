/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Facts about an account (admin status, sessions, product-access trust) live
// on its home bay. Code running on another bay, e.g., the owning bay of a
// routed project call, must ask the home bay instead of reading its own
// `accounts` table, which has no row (or a stale copy) for such accounts.

import getPool, { type PoolClient } from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { isMultiBayCluster } from "@cocalc/server/cluster-config";

// Home bays change only through an explicit, fenced rehome.
const DIRECTORY_CACHE_MS = 30_000;
const DIRECTORY_CACHE_MAX = 10_000;
const directoryCache = new Map<
  string,
  { home_bay_id: string | undefined; expires: number }
>();

/** True if a local `accounts` row says the account is homed on this bay. */
export function homedHere(home_bay_id: string | null | undefined): boolean {
  const here = getConfiguredBayId();
  return (`${home_bay_id ?? ""}`.trim() || here) === here;
}

/**
 * The account's home bay from the cluster directory, if it is another bay.
 * Accounts the directory does not know are treated as local, where they are
 * simply not found, as before.
 */
export async function directoryRemoteHomeBay(
  account_id: string,
): Promise<string | undefined> {
  const now = Date.now();
  const cached = directoryCache.get(account_id);
  if (cached != null && cached.expires > now) return cached.home_bay_id;
  const { resolveAccountHomeBay } =
    await import("@cocalc/server/bay-directory");
  let home_bay_id: string | undefined;
  try {
    const location = await resolveAccountHomeBay({ account_id });
    const home = `${location.home_bay_id ?? ""}`.trim();
    home_bay_id = home && home !== getConfiguredBayId() ? home : undefined;
  } catch (err) {
    if (!`${(err as Error)?.message ?? err}`.includes("not found")) throw err;
    home_bay_id = undefined;
  }
  if (directoryCache.size >= DIRECTORY_CACHE_MAX) {
    const oldest = directoryCache.keys().next().value;
    if (oldest != null) directoryCache.delete(oldest);
  }
  directoryCache.set(account_id, {
    home_bay_id,
    expires: now + DIRECTORY_CACHE_MS,
  });
  return home_bay_id;
}

/**
 * The account's home bay if it is another bay of a multibay cluster, else
 * undefined (single-bay deployments and accounts homed here). An account
 * homed here is recognized from the local row without any inter-bay call.
 */
export async function remoteHomeBay(
  account_id: string,
  client?: PoolClient,
): Promise<string | undefined> {
  if (!isMultiBayCluster()) return;
  const { rows } = await (client ?? getPool()).query<{
    home_bay_id: string | null;
  }>(
    "SELECT home_bay_id FROM accounts WHERE account_id=$1 AND deleted IS NOT TRUE",
    [account_id],
  );
  if (rows.length > 0 && homedHere(rows[0].home_bay_id)) return;
  return await directoryRemoteHomeBay(account_id);
}

export function clearHomeBayCacheForTests(): void {
  directoryCache.clear();
}
