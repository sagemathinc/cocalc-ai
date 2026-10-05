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

export type AccountHome =
  | { kind: "here" }
  | { kind: "remote"; bay_id: string }
  | { kind: "absent" };

// Only "remote" answers are cached: a stale one is caught by the home bay,
// which refuses (409) accounts it does not hold, and the caller forgets it.
// "Here" is decided from the local row on every call and never cached.
const REMOTE_CACHE_MS = 30_000;
const REMOTE_CACHE_MAX = 10_000;
const remoteCache = new Map<string, { bay_id: string; expires: number }>();

function conflict(account_id: string, detail: string): Error {
  return Object.assign(
    new Error(
      `the home bay of account ${account_id} is changing (${detail}); try again`,
    ),
    { code: 409 },
  );
}

/**
 * Where an account lives, for answering account-home questions.
 *
 * - "here": this bay's active row explicitly names this bay (a rehome flips
 *   the source's row away under the rehome fence), or a legacy row without a
 *   home bay that the cluster directory confirms.
 * - "remote": the cluster directory names another bay.
 * - "absent": the directory does not know the account, or names this bay but
 *   there is no active local row.
 *
 * Fails closed (409) when the local row names another bay that the directory
 * does not route to: the account is being rehomed, and that row's facts
 * (e.g. admin groups) must not be used.
 */
export async function resolveAccountHome(
  account_id: string,
  client?: PoolClient,
): Promise<AccountHome> {
  if (!isMultiBayCluster()) return { kind: "here" };
  const here = getConfiguredBayId();
  const { rows } = await (client ?? getPool()).query<{
    home_bay_id: string | null;
  }>(
    "SELECT home_bay_id FROM accounts WHERE account_id=$1 AND deleted IS NOT TRUE",
    [account_id],
  );
  const local = rows.length > 0 ? `${rows[0].home_bay_id ?? ""}`.trim() : null;
  if (local === here) return { kind: "here" };

  const now = Date.now();
  const cached = remoteCache.get(account_id);
  if (cached != null && cached.expires > now) {
    return { kind: "remote", bay_id: cached.bay_id };
  }
  const { getClusterAccountById } =
    await import("@cocalc/server/inter-bay/accounts");
  // Transport and directory failures propagate: never guess.
  const entry = await getClusterAccountById(account_id);
  if (!entry?.account_id) {
    if (local) {
      throw conflict(
        account_id,
        `unknown to the directory, local row: ${local}`,
      );
    }
    return { kind: "absent" };
  }
  const home = `${entry.home_bay_id ?? ""}`.trim() || here;
  if (home !== here) {
    if (remoteCache.size >= REMOTE_CACHE_MAX) {
      const oldest = remoteCache.keys().next().value;
      if (oldest != null) remoteCache.delete(oldest);
    }
    remoteCache.set(account_id, {
      bay_id: home,
      expires: now + REMOTE_CACHE_MS,
    });
    return { kind: "remote", bay_id: home };
  }
  if (local === "") return { kind: "here" };
  if (local == null) return { kind: "absent" };
  throw conflict(account_id, `local row names ${local}`);
}

/**
 * The account's home bay if it is another bay of a multibay cluster, else
 * undefined (single-bay deployments, accounts homed here, unknown accounts).
 */
export async function remoteHomeBay(
  account_id: string,
  client?: PoolClient,
): Promise<string | undefined> {
  const home = await resolveAccountHome(account_id, client);
  return home.kind === "remote" ? home.bay_id : undefined;
}

/** For the home bay's services: refuse (409) accounts not homed here. */
export async function assertAccountHomedHere(
  account_id: string,
): Promise<void> {
  if ((await resolveAccountHome(account_id)).kind !== "here") {
    throw Object.assign(new Error("account is not homed on this bay"), {
      code: 409,
    });
  }
}

/** Drop a cached home bay, e.g. after that bay refused the account (409). */
export function forgetAccountHome(account_id: string): void {
  remoteCache.delete(account_id);
}

/** Forget the cached home bay when the remote bay refused the account. */
export function forgetAccountHomeOn409(
  account_id: string,
  err: unknown,
): never {
  if ((err as any)?.code == 409 || (err as any)?.code === "409") {
    forgetAccountHome(account_id);
  }
  throw err;
}

export function clearHomeBayCacheForTests(): void {
  remoteCache.clear();
}
