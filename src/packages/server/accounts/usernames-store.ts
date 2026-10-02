/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import type { AccountUsername } from "@cocalc/conat/hub/api/personal-urls";
import type { PersonalUrlOwner } from "@cocalc/util/personal-urls";
import { normalizePersonalUrlOwner } from "@cocalc/util/personal-urls";
import { checkAccountName } from "@cocalc/util/db-schema/name-rules";
import { requireUuid } from "@cocalc/conat/agents/protocol";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";

// Includes the current name: clearing or returning to an old name is always
// possible at the limit without silently releasing any permanent redirects.
export const MAX_RETAINED_USERNAMES = 32;
const UUID_LIKE = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

export function normalizeUsername(username: string): string {
  if (typeof username !== "string") throw Error("Invalid username");
  const normalized = username.trim().toLowerCase();
  checkAccountName(normalized);
  if (UUID_LIKE.test(normalized)) throw Error("Username must not be UUID-like");
  return normalized;
}

export function assertUsernameAuthority(): void {
  if (getConfiguredBayId() !== getConfiguredClusterSeedBayId())
    throw Error("Usernames are authoritative on the seed bay");
}

type Query = Pick<PoolClient, "query">;

async function snapshot(
  db: Query,
  account_id: string,
): Promise<AccountUsername> {
  const { rows } = await db.query<{ username: string; active: boolean }>(
    "SELECT username,active FROM account_usernames WHERE account_id=$1 ORDER BY username",
    [account_id],
  );
  return {
    account_id: account_id.toLowerCase(),
    username: rows.find((row) => row.active)?.username ?? null,
    redirects: rows.filter((row) => !row.active).map((row) => row.username),
  };
}

async function requireAccount(account_id: string): Promise<void> {
  requireUuid(account_id, "account_id");
  const account = await getClusterAccountById(account_id.toLowerCase());
  if (!account) throw Error("Account not found");
  if (account.banned) throw Error("Account is unavailable");
}

async function locked<T>(
  account_id: string,
  fn: (db: PoolClient) => Promise<T>,
): Promise<T> {
  assertUsernameAuthority();
  requireUuid(account_id, "account_id");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    // Serialize same-owner renames/releases and the retained-name count, even
    // before the account has any username rows. The PK arbitrates other owners.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `account-usernames:${account_id.toLowerCase()}`,
    ]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getUsernameLocal(
  account_id: string,
  { inspect = false }: { inspect?: boolean } = {},
): Promise<AccountUsername> {
  assertUsernameAuthority();
  requireUuid(account_id, "account_id");
  // Only the authorized admin-target path may inspect reservations left by an
  // unavailable/deleted owner; ordinary owner resolution must still fail.
  if (!inspect) await requireAccount(account_id);
  return snapshot(getPool(), account_id);
}

export async function setUsernameLocal(
  account_id: string,
  username: string | null,
): Promise<AccountUsername> {
  assertUsernameAuthority();
  const name = username === null ? null : normalizeUsername(username);
  await requireAccount(account_id);
  return locked(account_id, async (db) => {
    const current = await snapshot(db, account_id);
    if (current.username === name) return current;
    if (name !== null && !current.redirects.includes(name)) {
      if (
        current.redirects.length + (current.username === null ? 0 : 1) >=
        MAX_RETAINED_USERNAMES
      )
        throw Error(
          `Username limit reached (${MAX_RETAINED_USERNAMES} retained names)`,
        );
      // Claim inactive first so a conflicting reservation never clears the
      // caller's current name. ON CONFLICT also handles simultaneous claims.
      const claimed = await db.query(
        `INSERT INTO account_usernames(username,account_id,active) VALUES($1,$2,FALSE)
         ON CONFLICT(username) DO NOTHING RETURNING username`,
        [name, account_id],
      );
      if (!claimed.rows.length) throw Error("Username is already reserved");
    }
    await db.query(
      "UPDATE account_usernames SET active=FALSE WHERE account_id=$1 AND active",
      [account_id],
    );
    if (name !== null)
      await db.query(
        "UPDATE account_usernames SET active=TRUE WHERE account_id=$1 AND username=$2",
        [account_id, name],
      );
    return snapshot(db, account_id);
  });
}

export async function releaseUsernameRedirectLocal({
  account_id,
  owner_account_id,
  username,
  reason,
}: {
  account_id: string;
  owner_account_id: string;
  username: string;
  reason: string;
}): Promise<void> {
  assertUsernameAuthority();
  requireUuid(account_id, "account_id");
  const name = normalizeUsername(username);
  if (
    typeof reason !== "string" ||
    !reason.trim() ||
    reason.trim().length > 4000
  )
    throw Error("A release reason of 1 to 4000 characters is required");
  // Do not require a live owner account: admins must also be able to release
  // redirects retained by a deleted account, but never its current name.
  await locked(owner_account_id, async (db) => {
    const removed = await db.query(
      `DELETE FROM account_usernames WHERE account_id=$1 AND username=$2 AND NOT active RETURNING username`,
      [owner_account_id, name],
    );
    if (!removed.rows.length)
      throw Error("No matching username redirect to release");
    await db.query(
      `INSERT INTO account_username_release_log(id,owner_account_id,actor_account_id,username,reason)
       VALUES($1,$2,$3,$4,$5)`,
      [randomUUID(), owner_account_id, account_id, name, reason.trim()],
    );
  });
}

export async function resolveUsernameOwnerLocal(
  owner: string,
): Promise<PersonalUrlOwner> {
  assertUsernameAuthority();
  const normalized = normalizePersonalUrlOwner(owner);
  if (UUID_LIKE.test(normalized)) {
    const result = await getUsernameLocal(normalized);
    return {
      account_id: result.account_id,
      username: result.username,
      redirect: result.username !== null,
    };
  }
  // One statement gives a consistent reservation/current-name snapshot during
  // concurrent renames without exposing any of the owner's other redirects.
  const { rows } = await getPool().query<{
    account_id: string;
    username: string | null;
    redirect: boolean;
  }>(
    `SELECT reserved.account_id,current.username,NOT reserved.active AS redirect
       FROM account_usernames AS reserved
       LEFT JOIN account_usernames AS current ON current.account_id=reserved.account_id AND current.active
       WHERE reserved.username=$1`,
    [normalized],
  );
  if (!rows[0]) throw Error("Username owner not found");
  await requireAccount(rows[0].account_id);
  return rows[0];
}
