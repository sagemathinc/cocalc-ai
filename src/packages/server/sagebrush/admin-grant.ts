/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The Sagebrush admin page's grant and admin check (Sagebrush's admin-visibility
plan r1h §1.4 and §1.8; the contract is ./cocalc-admin-contract.json, a
byte-identical copy of Sagebrush's, pinned by sha256 in the tests).

- A grant is minted at token time, on the account's home bay, from the
  approving browser session's live state: only for a non-deleted admin with
  2FA on, whose session is live and still has the factor time the code was
  approved with, with fresh_auth_until set and in the future, and within 600 s
  of that factor. It expires at floor(min(factor + 600, the session's expire,
  its fresh_auth_until)).
- The admin check answers from the home bay, read live every call: the grant's
  form only while every condition above still holds, its expiry recomputed
  now and capped at the issued one (never sliding); otherwise the refused form.

Every routing or lookup failure throws, which the callers turn into no grant
or a non-200: nothing here fails open.
*/

import { randomBytes } from "node:crypto";

import getPool, { type PoolClient } from "@cocalc/database/pool";
import { withAccountRehomeWriteFence } from "@cocalc/server/accounts/rehome-fence";
import { isValidUUID } from "@cocalc/util/misc";

export const FACTOR_SECONDS = 600;

export interface SagebrushAdminGrant {
  grant_id: string;
  factor_verified_at: number;
  expires_at: number;
}
export type SagebrushAdminAnswer =
  | { admin: false }
  | { admin: true; two_factor: false }
  | { admin: true; two_factor: true }
  | {
      admin: true;
      two_factor: true;
      factor_verified_at: number;
      expires_at: number;
    };

// (milliseconds; only the tests replace it)
let clock = () => Date.now();
export function setSagebrushAdminClock(f: () => number): void {
  clock = f;
}

const GRANT_ID = /^[A-Za-z0-9_-]{8,200}$/;
const seconds = (d: Date | string | null | undefined): number | null =>
  d == null ? null : Math.floor(new Date(d).valueOf() / 1000);

/** The account's admin and 2FA facts, read on its home bay: a missing,
 * deleted or banned account is not an admin. */
async function accountFacts(
  db: PoolClient,
  account_id: string,
  requireApproval = false,
): Promise<{ admin: boolean; two_factor: boolean }> {
  const { rows } = await db.query<{
    admin: boolean;
    two_factor: boolean;
  }>(
    `SELECT 'admin' = ANY(COALESCE(a.groups, '{}'::TEXT[])) AS admin,
            EXISTS (
              SELECT 1 FROM account_second_factors AS f
               WHERE f.account_id = a.account_id
                 AND f.status = 'active'
                 AND f.activated_at IS NOT NULL
                 AND f.disabled_at IS NULL
            ) AS two_factor
       FROM accounts AS a
      WHERE a.account_id = $1::UUID
        AND a.deleted IS NOT TRUE
        AND a.banned IS NOT TRUE
        AND (NOT $2::BOOLEAN OR (
          EXISTS (SELECT 1 FROM oauth_client_approvals AS p
                   WHERE p.account_id = a.account_id AND p.client_id = 'sagebrush')
          OR EXISTS (SELECT 1 FROM sagebrush_admin_grants AS g
                      WHERE g.account_id = a.account_id)
        ))`,
    [account_id, requireApproval],
  );
  return {
    admin: rows[0]?.admin === true,
    two_factor: rows[0]?.two_factor === true,
  };
}

/** The grant's expiry from a session's values now (seconds), or null when the
 * session no longer allows one. */
export function liveExpiry({
  factor,
  expire,
  fresh_until,
  now,
}: {
  factor: number | null;
  expire: number | null;
  fresh_until: number | null;
  now: number;
}): number | null {
  if (factor == null || expire == null || fresh_until == null) return null;
  if (!(now < fresh_until)) return null;
  if (!(now < expire)) return null;
  if (!(factor <= now && now < factor + FACTOR_SECONDS)) return null;
  return Math.floor(Math.min(factor + FACTOR_SECONDS, expire, fresh_until));
}

type SessionRow = {
  factor_verified_at: Date | null;
  fresh_auth_until: Date | null;
  expire: Date | null;
};
async function liveSession(
  db: PoolClient,
  account_id: string,
  session_hash: string,
): Promise<SessionRow | undefined> {
  return (
    await db.query<SessionRow>(
      `SELECT factor_verified_at, fresh_auth_until, expire
         FROM account_auth_sessions
        WHERE session_hash = $1::CHAR(127)
          AND account_id = $2::UUID
          AND revoked_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM account_impersonation_sessions AS i
             WHERE i.session_hash = account_auth_sessions.session_hash
          )`,
      [session_hash, account_id],
    )
  ).rows[0];
}

/** On the home bay, at token time: a new grant, or null. */
async function mintSagebrushAdminGrantForSession(
  db: PoolClient,
  {
    account_id,
    session_hash,
    factor_verified_at,
  }: {
    account_id: string;
    session_hash: string;
    factor_verified_at: number;
  },
): Promise<SagebrushAdminGrant | null> {
  if (
    !isValidUUID(account_id) ||
    !session_hash ||
    !Number.isInteger(factor_verified_at)
  )
    return null;
  const facts = await accountFacts(db, account_id);
  if (!facts.admin || !facts.two_factor) return null;
  const s = await liveSession(db, account_id, session_hash);
  if (s == null) return null;
  const factor = seconds(s.factor_verified_at);
  if (factor !== factor_verified_at) return null;
  // (the issue-time checks and formula, kept apart from the live ones below so that each has its own control)
  const now = clock() / 1000,
    expire = seconds(s.expire),
    fresh_until = seconds(s.fresh_auth_until);
  if (expire == null || !(now < expire)) return null;
  if (fresh_until == null || !(now < fresh_until)) return null;
  if (!(factor <= now && now < factor + FACTOR_SECONDS)) return null;
  const expires_at = Math.floor(
    Math.min(factor + FACTOR_SECONDS, expire, fresh_until),
  );
  const grant_id = randomBytes(24).toString("base64url");
  // (expired grants go a day after their expiry, here, as codes go when new ones are stored)
  await db.query(
    `DELETE FROM sagebrush_admin_grants WHERE expires_at < NOW() - INTERVAL '1 day'`,
  );
  await db.query(
    `INSERT INTO sagebrush_admin_grants(grant_id, account_id, session_hash, factor_verified_at, expires_at, created)
     VALUES($1, $2::UUID, $3::CHAR(127), $4, $5, NOW())`,
    [
      grant_id,
      account_id,
      session_hash,
      new Date(factor * 1000),
      new Date(expires_at * 1000),
    ],
  );
  return { grant_id, factor_verified_at: factor, expires_at };
}

/** Consume the home-bay approval reference exactly once at token time.
 * The signed browser proof carries only this opaque id, not session facts. */
async function mintSagebrushAdminGrantInFence(
  db: PoolClient,
  {
    account_id,
    approval_id,
  }: {
    account_id: string;
    approval_id: string;
  },
): Promise<SagebrushAdminGrant | null> {
  if (!isValidUUID(account_id) || !/^[A-Za-z0-9_-]{43}$/.test(approval_id))
    return null;
  const { rows } = await db.query<{
    session_hash: string;
    factor_verified_at: Date;
  }>(
    `DELETE FROM sagebrush_admin_approvals
      WHERE approval_id = $1 AND account_id = $2::UUID AND expire > NOW()
      RETURNING session_hash, factor_verified_at`,
    [approval_id, account_id],
  );
  const approval = rows[0];
  if (approval == null) return null;
  return await mintSagebrushAdminGrantForSession(db, {
    account_id,
    session_hash: approval.session_hash.trim(),
    factor_verified_at: seconds(approval.factor_verified_at)!,
  });
}

/** On the home bay, every admin check: the contract's answer, read live. */
async function sagebrushAdminAnswerInFence(
  db: PoolClient,
  {
    account_id,
    grant,
  }: {
    account_id: string;
    grant?: string | null;
  },
): Promise<SagebrushAdminAnswer> {
  if (!isValidUUID(account_id)) return { admin: false };
  const facts = await accountFacts(db, account_id, true);
  if (!facts.admin) return { admin: false };
  if (!facts.two_factor) return { admin: true, two_factor: false };
  const refused = { admin: true, two_factor: true } as const;
  if (grant == null) return refused;
  if (!GRANT_ID.test(grant)) return refused;
  const g = (
    await db.query<{
      session_hash: string;
      factor_verified_at: Date;
      expires_at: Date;
    }>(
      `SELECT session_hash, factor_verified_at, expires_at
         FROM sagebrush_admin_grants
        WHERE grant_id = $1 AND account_id = $2::UUID`,
      [grant, account_id],
    )
  ).rows[0];
  if (g == null) return refused;
  const s = await liveSession(db, account_id, `${g.session_hash}`.trim());
  if (s == null) return refused;
  const factor = seconds(s.factor_verified_at);
  if (factor == null || factor !== seconds(g.factor_verified_at))
    return refused;
  const now = clock() / 1000;
  const live = liveExpiry({
    factor,
    expire: seconds(s.expire),
    fresh_until: seconds(s.fresh_auth_until),
    now,
  });
  if (live == null) return refused;
  const expires_at = Math.min(live, seconds(g.expires_at)!);
  if (!(now < expires_at)) return refused;
  return {
    admin: true,
    two_factor: true,
    factor_verified_at: factor,
    expires_at,
  };
}

// A negative-only preflight preserves the absent/deleted-account refusal in
// single-bay deployments too. Presence never admits: the fence rechecks home
// ownership and all account/session/grant facts before any successful result.
async function hasLiveAccount(account_id: string): Promise<boolean> {
  return (
    (
      await getPool().query(
        "SELECT 1 FROM accounts WHERE account_id=$1 AND deleted IS NOT TRUE",
        [account_id],
      )
    ).rows.length > 0
  );
}

/** Keep every local read and write inside the same home-bay transaction fence. */
export async function mintSagebrushAdminGrantLocal(opts: {
  account_id: string;
  approval_id: string;
}): Promise<SagebrushAdminGrant | null> {
  if (!isValidUUID(opts.account_id) || !(await hasLiveAccount(opts.account_id)))
    return null;
  return await withAccountRehomeWriteFence({
    account_id: opts.account_id,
    action: "mint a Sagebrush admin grant",
    fn: (db) => mintSagebrushAdminGrantInFence(db, opts),
  });
}

export async function sagebrushAdminAnswerLocal(opts: {
  account_id: string;
  grant?: string | null;
}): Promise<SagebrushAdminAnswer> {
  if (!isValidUUID(opts.account_id) || !(await hasLiveAccount(opts.account_id)))
    return { admin: false };
  return await withAccountRehomeWriteFence({
    account_id: opts.account_id,
    action: "check a Sagebrush admin grant",
    fn: (db) => sagebrushAdminAnswerInFence(db, opts),
  });
}

/** From any bay: the home bay mints (null: no grant). Throws when the home
 * can't be reached, so the token exchange answers no grant. */
export async function mintSagebrushAdminGrant(opts: {
  account_id: string;
  approval_id: string;
}): Promise<SagebrushAdminGrant | null> {
  const { remoteHomeBay, forgetAccountHomeOn409 } =
    await import("@cocalc/server/accounts/home-bay");
  const home = await remoteHomeBay(opts.account_id);
  if (home == null) return await mintSagebrushAdminGrantLocal(opts);
  const { createInterBayAccountFactsClient } =
    await import("@cocalc/conat/inter-bay/account-facts");
  const { getInterBayFabricClient } =
    await import("@cocalc/server/inter-bay/fabric");
  try {
    return await createInterBayAccountFactsClient({
      client: getInterBayFabricClient(),
      bay_id: home,
    }).sagebrushAdminMint(opts);
  } catch (err) {
    return forgetAccountHomeOn409(opts.account_id, err);
  }
}

/** From any bay: the home bay's answer. Throws on any routing failure, which
 * the endpoint answers with a non-200. */
export async function getSagebrushAdminAnswer(opts: {
  account_id: string;
  grant?: string | null;
}): Promise<SagebrushAdminAnswer> {
  const { remoteHomeBay, forgetAccountHomeOn409 } =
    await import("@cocalc/server/accounts/home-bay");
  const home = await remoteHomeBay(opts.account_id);
  if (home == null) return await sagebrushAdminAnswerLocal(opts);
  const { createInterBayAccountFactsClient } =
    await import("@cocalc/conat/inter-bay/account-facts");
  const { getInterBayFabricClient } =
    await import("@cocalc/server/inter-bay/fabric");
  try {
    return await createInterBayAccountFactsClient({
      client: getInterBayFabricClient(),
      bay_id: home,
    }).sagebrushAdminAnswer({
      account_id: opts.account_id,
      grant: opts.grant ?? null,
    });
  } catch (err) {
    return forgetAccountHomeOn409(opts.account_id, err);
  }
}
