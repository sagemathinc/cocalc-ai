/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Sign-in session expiry: an idle timeout and a maximum lifetime.

A remember_me session works until `expire`, which is always

    LEAST(last_used + idle timeout, max_expire)

where max_expire is sign-in (or the last re-entered password or second factor)
plus the maximum lifetime. Using a session records last_used, at most about
once an hour, which moves `expire` forward: people are not signed out while
they use the site. A connected browser counts as using its session, so a long
open tab never goes idle. Every check of a session keeps testing only
`expire`, so all existing checks keep working unchanged.

All of this runs on the account's home bay, where its remember_me rows are;
other bays check a cookie through the home bay (inter-bay
getAccountIdFromRememberMe), which records the use there.
*/

import getPool from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import getLogger from "@cocalc/backend/logger";
import { SESSION_LIMIT_MAX_DAYS } from "@cocalc/util/db-schema/site-defaults";
import { withAccountRehomeWriteFence } from "@cocalc/server/accounts/rehome-fence";

const logger = getLogger("server:auth:session-expiry");

const DAY_MS = 24 * 60 * 60_000;
export const DEFAULT_SESSION_IDLE_TIMEOUT_DAYS = 14;
export const DEFAULT_SESSION_MAX_LIFETIME_DAYS = 60;
// Recording use more often than this would only add writes.
export const SESSION_TOUCH_INTERVAL_MS = 60 * 60_000;
// The browser keeps the cookie this long (the most browsers allow); the server
// decides when a session ends, so the browser never drops a cookie the server
// still accepts.
export const BROWSER_SESSION_COOKIE_MAX_AGE_MS = 400 * DAY_MS;
// The frontend asks for the password or second factor from this long before
// the maximum lifetime ends.
export const SESSION_LIFETIME_WARNING_MS = 3 * DAY_MS;
// After a refused write (e.g., during a rehome), record use again this soon.
const TOUCH_RETRY_MS = 5 * 60_000;
const MAINTENANCE_INTERVAL_MS = 60 * 60_000;
const MAINTENANCE_BATCH = 5000;
// Accounts whose live sessions are changed per pass, each in its own fenced
// transaction.
const MAINTENANCE_ACCOUNT_BATCH = 500;

export interface SessionLimits {
  idle_ms: number;
  max_lifetime_ms: number;
}

// Saving the settings checks them (sessionLimitSettingsError); a value from
// elsewhere (an old row, an environment variable) that is out of range falls
// back to the default.
function sessionDays(value: unknown, fallback: number): number {
  const days = Number(value);
  return Number.isInteger(days) && days > 0 && days <= SESSION_LIMIT_MAX_DAYS
    ? days
    : fallback;
}

export function sessionLimitsFromSettings(settings: {
  session_idle_timeout_days?: unknown;
  session_max_lifetime_days?: unknown;
}): SessionLimits {
  const idleDays = sessionDays(
    settings.session_idle_timeout_days,
    DEFAULT_SESSION_IDLE_TIMEOUT_DAYS,
  );
  const maxDays = sessionDays(
    settings.session_max_lifetime_days,
    DEFAULT_SESSION_MAX_LIFETIME_DAYS,
  );
  // A session can never outlive its maximum lifetime, so an idle timeout
  // longer than it means the maximum lifetime alone.
  return {
    idle_ms: Math.min(idleDays, maxDays) * DAY_MS,
    max_lifetime_ms: maxDays * DAY_MS,
  };
}

export async function getSessionLimits(): Promise<SessionLimits> {
  return sessionLimitsFromSettings((await getServerSettings()) as any);
}

// The expiry of a session created now whose lifetime is at most
// lifetime_ms (shorter for impersonation and some automated sign-ins).
export function newSessionExpiry({
  limits,
  lifetime_ms,
  now = Date.now(),
}: {
  limits: SessionLimits;
  lifetime_ms?: number;
  now?: number;
}): { expire: Date; max_expire: Date; last_used: Date } {
  const lifetime = Math.min(
    limits.max_lifetime_ms,
    lifetime_ms != null && lifetime_ms > 0 ? lifetime_ms : Infinity,
  );
  const max_expire = now + lifetime;
  return {
    last_used: new Date(now),
    max_expire: new Date(max_expire),
    expire: new Date(Math.min(now + limits.idle_ms, max_expire)),
  };
}

// The account_auth_sessions row mirrors the remember_me expiry, because
// getCurrentAuthSession checks it too.
// Appended to a "WITH r AS (... RETURNING hash, expire)" statement; the
// statement then returns one row per changed remember_me row.
const SYNC_AUTH_SESSION_EXPIRE = `
  , synced AS (
    UPDATE account_auth_sessions s
       SET expire = r.expire
      FROM r
     WHERE s.session_hash = r.hash
       AND s.expire IS DISTINCT FROM r.expire
    RETURNING 1
  )
  SELECT hash FROM r
`;

const lastTouchMs = new Map<string, number>();

function rememberTouch(hash: string, now: number): boolean {
  const last = lastTouchMs.get(hash);
  if (last != null && now - last < SESSION_TOUCH_INTERVAL_MS) return false;
  lastTouchMs.set(hash, now);
  if (lastTouchMs.size > 100_000) {
    for (const [key, at] of lastTouchMs) {
      if (now - at >= SESSION_TOUCH_INTERVAL_MS) lastTouchMs.delete(key);
    }
  }
  return true;
}

// Record that a valid session was just used. Cheap to call on every
// successful authentication: writes happen at most about once an hour per
// session, in this process and (by the last_used test) across processes.
// Never revives a session that has already ended. Like every other write to
// an account's sessions, it goes through the account rehome fence: it is
// refused while the account moves to another bay (its rows are being copied)
// and on a bay that is not the account's home.
export async function touchSession({
  hash,
  account_id,
}: {
  hash: string;
  account_id: string;
}): Promise<void> {
  if (!hash || !account_id) return;
  const now = Date.now();
  if (!rememberTouch(hash, now)) return;
  try {
    const { idle_ms, max_lifetime_ms } = await getSessionLimits();
    await withAccountRehomeWriteFence({
      account_id,
      action: "record session use",
      fn: async (db) => {
        await db.query(
          `
            WITH r AS (
              UPDATE remember_me
                 SET last_used = NOW(),
                     max_expire = COALESCE(
                       max_expire,
                       LEAST(expire, NOW() + $3 * INTERVAL '1 millisecond')
                     ),
                     expire = LEAST(
                       NOW() + $2 * INTERVAL '1 millisecond',
                       COALESCE(
                         max_expire,
                         LEAST(expire, NOW() + $3 * INTERVAL '1 millisecond')
                       )
                     )
               WHERE hash = $1::CHAR(127)
                 AND account_id = $5::UUID
                 AND expire > NOW()
                 AND (
                   last_used IS NULL
                   OR last_used < NOW() - $4 * INTERVAL '1 millisecond'
                 )
              RETURNING hash, expire
            )
            ${SYNC_AUTH_SESSION_EXPIRE}
          `,
          [
            hash.slice(0, 127),
            idle_ms,
            max_lifetime_ms,
            SESSION_TOUCH_INTERVAL_MS,
            account_id,
          ],
        );
      },
    });
  } catch (err) {
    // Use is recorded again a little later (a rehome refuses writes for a
    // while); a failed write must not fail the request that used the session.
    lastTouchMs.set(hash, now - SESSION_TOUCH_INTERVAL_MS + TOUCH_RETRY_MS);
    logger.debug("recording session use failed", { err: `${err}` });
  }
}

// For tests.
export function resetSessionTouchesForTest(): void {
  lastTouchMs.clear();
}

// After the person re-enters their password or second factor, the session
// starts a new maximum lifetime. Runs in the caller's transaction (db).
export async function renewSessionLifetime({
  db,
  hash,
  account_id,
}: {
  db: { query: (sql: string, params?: any[]) => Promise<any> };
  hash: string;
  account_id: string;
}): Promise<void> {
  const { idle_ms, max_lifetime_ms } = await getSessionLimits();
  await db.query(
    `
      WITH r AS (
        UPDATE remember_me
           SET last_used = NOW(),
               max_expire = NOW() + $4 * INTERVAL '1 millisecond',
               expire = NOW() + LEAST($3, $4) * INTERVAL '1 millisecond'
         WHERE hash = $1::CHAR(127)
           AND account_id = $2::UUID
           AND expire > NOW()
        RETURNING hash, expire
      )
      ${SYNC_AUTH_SESSION_EXPIRE}
    `,
    [hash.slice(0, 127), account_id, idle_ms, max_lifetime_ms],
  );
  lastTouchMs.set(hash, Date.now());
}

// When the session's maximum lifetime ends, for the frontend warning.
export async function getSessionMaxExpire(
  hash: string,
): Promise<Date | undefined> {
  const row = (
    await getPool().query(
      "SELECT max_expire, expire FROM remember_me WHERE hash = $1::CHAR(127)",
      [hash.slice(0, 127)],
    )
  ).rows[0];
  return row?.max_expire ?? row?.expire ?? undefined;
}

// Sessions held by connected browsers on this process count as used.
const connectedSessions = new Map<
  string,
  { account_id: string; count: number }
>();

export function trackConnectedSession({
  hash,
  account_id,
}: {
  hash: string;
  account_id: string;
}): () => void {
  if (!hash || !account_id) return () => {};
  const entry = connectedSessions.get(hash);
  if (entry) entry.count += 1;
  else connectedSessions.set(hash, { account_id, count: 1 });
  ensureConnectedTouchLoop();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = connectedSessions.get(hash);
    if (current == null) return;
    current.count -= 1;
    if (current.count <= 0) connectedSessions.delete(hash);
  };
}

// For tests.
export function connectedSessionCount(hash: string): number {
  return connectedSessions.get(hash)?.count ?? 0;
}

let connectedTouchTimer: ReturnType<typeof setInterval> | undefined;

function ensureConnectedTouchLoop(): void {
  if (connectedTouchTimer != null) return;
  connectedTouchTimer = setInterval(() => {
    for (const [hash, { account_id }] of connectedSessions) {
      void touchSession({ hash, account_id });
    }
  }, SESSION_TOUCH_INTERVAL_MS / 4);
  connectedTouchTimer.unref?.();
}

export interface SessionMaintenanceResult {
  started_idle_clock?: number;
  reapplied_limits?: number;
  removed?: number;
  // More is waiting: run again soon.
  more?: boolean;
}

async function accountRehomeOperationsExist(db): Promise<boolean> {
  const { rows } = await db.query(
    "SELECT to_regclass('public.account_rehome_operations') AS t",
  );
  return rows[0]?.t != null;
}

// Changes one account's live sessions inside the account rehome fence, as
// every other write to them: refused while the account is being rehomed (its
// rows are being copied to another bay) and on a bay that is not its home.
async function maintainAccountSessions({
  account_id,
  idle_ms,
  max_lifetime_ms,
}: {
  account_id: string;
  idle_ms: number;
  max_lifetime_ms: number;
}): Promise<{ started: number; reapplied: number }> {
  return await withAccountRehomeWriteFence({
    account_id,
    action: "apply session limits",
    fn: async (db) => {
      const started = await db.query(
        `
          WITH r AS (
            UPDATE remember_me
               SET last_used = NOW(),
                   max_expire = LEAST(expire, NOW() + $3 * INTERVAL '1 millisecond'),
                   expire = LEAST(
                     expire,
                     NOW() + $2 * INTERVAL '1 millisecond',
                     NOW() + $3 * INTERVAL '1 millisecond'
                   )
             WHERE account_id = $1::UUID
               AND last_used IS NULL
               AND expire > NOW()
            RETURNING hash, expire
          )
          ${SYNC_AUTH_SESSION_EXPIRE}
        `,
        [account_id, idle_ms, max_lifetime_ms],
      );
      const reapplied = await db.query(
        `
          WITH r AS (
            UPDATE remember_me
               SET expire = LEAST(
                     last_used + $2 * INTERVAL '1 millisecond',
                     max_expire
                   )
             WHERE account_id = $1::UUID
               AND last_used IS NOT NULL
               AND max_expire IS NOT NULL
               AND expire > NOW()
               AND expire IS DISTINCT FROM LEAST(
                 last_used + $2 * INTERVAL '1 millisecond',
                 max_expire
               )
            RETURNING hash, expire
          )
          ${SYNC_AUTH_SESSION_EXPIRE}
        `,
        [account_id, idle_ms],
      );
      return {
        started: started.rowCount ?? 0,
        reapplied: reapplied.rowCount ?? 0,
      };
    },
  });
}

// One bounded pass on this bay, by one process at a time:
// - sessions from before idle timeouts start their idle clock now, with a
//   lifetime ending at most one maximum lifetime from now (nobody is signed
//   out at deploy);
// - sessions follow a changed idle timeout from their last use;
// - ended sessions are deleted, and their auth sessions revoked.
// Live sessions change only through the account rehome fence, per account.
// Deleting ended sessions needs no fence: they no longer work anywhere, so
// whether a rehome copies one makes no difference (the destination deletes it
// in turn); accounts being rehomed are still skipped.
export async function runSessionMaintenance({
  batch = MAINTENANCE_BATCH,
  account_batch = MAINTENANCE_ACCOUNT_BATCH,
}: {
  batch?: number;
  account_batch?: number;
} = {}): Promise<SessionMaintenanceResult> {
  const { idle_ms, max_lifetime_ms } = await getSessionLimits();
  const client = await getPool().connect();
  let broken = false;
  try {
    const locked = (
      await client.query(
        "SELECT pg_try_advisory_lock(hashtextextended('session-expiry-maintenance',0)) AS locked",
      )
    ).rows[0]?.locked;
    if (!locked) return {};
    try {
      const notRehoming = (await accountRehomeOperationsExist(client))
        ? `AND NOT EXISTS (
             SELECT 1 FROM account_rehome_operations o
              WHERE o.account_id = m.account_id AND o.status = 'running'
           )`
        : "";
      // In random order, so an account the fence keeps refusing (being
      // rehomed, or homed elsewhere) cannot hold back the others. The fence
      // alone decides which bay owns an account: its directory entry wins
      // over the accounts row, which can lag behind a failed cutover.
      const accounts = (
        await client.query(
          `
            SELECT account_id FROM (
              SELECT DISTINCT m.account_id
                FROM remember_me m
                JOIN accounts a ON a.account_id = m.account_id
               WHERE a.deleted IS NOT TRUE
                 AND m.expire > NOW()
                 AND (
                   m.last_used IS NULL
                   OR (
                     m.max_expire IS NOT NULL
                     AND m.expire IS DISTINCT FROM LEAST(
                       m.last_used + $1 * INTERVAL '1 millisecond',
                       m.max_expire
                     )
                   )
                 )
                 ${notRehoming}
            ) t
            ORDER BY random()
            LIMIT $2
          `,
          [idle_ms, account_batch],
        )
      ).rows.map(({ account_id }) => account_id as string);
      let started = 0;
      let reapplied = 0;
      let changedAccounts = 0;
      for (const account_id of accounts) {
        try {
          const r = await maintainAccountSessions({
            account_id,
            idle_ms,
            max_lifetime_ms,
          });
          started += r.started;
          reapplied += r.reapplied;
          changedAccounts += 1;
        } catch (err) {
          // Refused by the rehome fence (or failed): its next pass retries.
          logger.debug("session maintenance skipped an account", {
            account_id,
            err: `${err}`,
          });
        }
      }
      const removed = await client.query(
        `
          WITH r AS (
            DELETE FROM remember_me
             WHERE hash IN (
               SELECT m.hash FROM remember_me m
                WHERE m.expire <= NOW()
                ${notRehoming}
                LIMIT $1
             )
            RETURNING hash
          ), revoked AS (
            UPDATE account_auth_sessions s
               SET revoked_at = COALESCE(s.revoked_at, NOW()), updated = NOW()
              FROM r
             WHERE s.session_hash = r.hash
            RETURNING 1
          )
          SELECT hash FROM r
        `,
        [batch],
      );
      const removedCount = removed.rowCount ?? 0;
      return {
        started_idle_clock: started,
        reapplied_limits: reapplied,
        removed: removedCount,
        // Continue soon only while passes make progress, so accounts the
        // fence keeps refusing cannot spin.
        more:
          (accounts.length >= account_batch && changedAccounts > 0) ||
          removedCount >= batch,
      };
    } finally {
      await client.query(
        "SELECT pg_advisory_unlock(hashtextextended('session-expiry-maintenance',0))",
      );
    }
  } catch (err) {
    broken = true;
    throw err;
  } finally {
    // A connection whose unlock may have failed must not return to the pool
    // still holding the lock.
    client.release(broken);
  }
}

export function startSessionMaintenance(): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(run, delay);
    timer.unref?.();
  };
  const run = async () => {
    if (stopped) return;
    let delay = MAINTENANCE_INTERVAL_MS;
    try {
      const result = await runSessionMaintenance();
      if (
        result.started_idle_clock ||
        result.reapplied_limits ||
        result.removed
      ) {
        logger.info("session expiry maintenance", result);
      }
      // More is waiting: continue soon, in bounded steps.
      if (result.more) {
        delay = 1_000;
      }
    } catch (err) {
      logger.warn("session expiry maintenance failed", { err: `${err}` });
      delay = 60_000;
    } finally {
      schedule(delay);
    }
  };
  schedule(30_000);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
