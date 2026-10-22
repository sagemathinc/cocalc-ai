import getPool from "@cocalc/database/pool";
import { isValidUUID } from "@cocalc/util/misc";
import getLogger from "@cocalc/backend/logger";
import { recordAccountSecurityState } from "./security-state";
import {
  endAllSignInSessions,
  endOtherSignInSessions,
} from "@cocalc/server/auth/auth-sessions";
import { requestSignedOutSessionSweep } from "@cocalc/server/conat/socketio/sign-in-session-sweep";

const logger = getLogger("server:accounts:revocation");

let ensured = false;

export async function ensureAccountRevocationsTable(): Promise<void> {
  await ensureTable();
}

async function ensureTable() {
  if (ensured) return;
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_revocations (
      account_id UUID PRIMARY KEY,
      revoked_before TIMESTAMP NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS account_revocations_updated_idx
    ON account_revocations(updated_at, account_id)
  `);
  // Content-origin links only (trust-free step 6): revoked on password change
  // and "sign out other sessions", which leave host sessions alone.
  await pool.query(`
    ALTER TABLE account_revocations
    ADD COLUMN IF NOT EXISTS content_revoked_before TIMESTAMP
  `);
  // Browser sessions on project hosts only: ended when a password changes or
  // other sessions are signed out. The hub never reads it, so this browser's
  // own hub session and agent runs carry on.
  await pool.query(`
    ALTER TABLE account_revocations
    ADD COLUMN IF NOT EXISTS browser_revoked_before TIMESTAMP
  `);
  ensured = true;
}

export async function recordAccountRevocation(
  account_id: string,
  revoked_before_ms = Date.now(),
  security_state: { banned?: boolean } = {},
): Promise<void> {
  if (!isValidUUID(account_id)) {
    throw new Error("invalid account_id");
  }
  await ensureTable();
  const pool = getPool();
  const revokedBefore = new Date(revoked_before_ms);
  await pool.query(
    `
      INSERT INTO account_revocations(account_id, revoked_before, updated_at)
      VALUES($1::UUID, $2::TIMESTAMP, NOW())
      ON CONFLICT (account_id) DO UPDATE SET
        revoked_before = GREATEST(account_revocations.revoked_before, EXCLUDED.revoked_before),
        updated_at = NOW()
    `,
    [account_id, revokedBefore],
  );
  await recordAccountSecurityState({
    account_id,
    ...security_state,
    revoked_before_ms,
  });
}

// Hosts refuse links with iat * 1000 <= cutoff, and iat is in whole seconds.
// Ending the cutoff just before the current second keeps links this browser
// re-issues right away valid (a link minted earlier in the same second by
// someone else survives; that second is the price).
export function contentCutoffNow(now_ms = Date.now()): number {
  return Math.floor(now_ms / 1000) * 1000 - 1;
}

// Every content-origin link of the account issued before now stops working;
// sessions are untouched (the current browser just re-issues its links).
export async function recordContentRevocation(
  account_id: string,
  content_revoked_before_ms = contentCutoffNow(),
): Promise<void> {
  if (!isValidUUID(account_id)) {
    throw new Error("invalid account_id");
  }
  await ensureTable();
  await getPool().query(
    `
      INSERT INTO account_revocations(account_id, revoked_before, content_revoked_before, updated_at)
      VALUES($1::UUID, to_timestamp(0), $2::TIMESTAMP, NOW())
      ON CONFLICT (account_id) DO UPDATE SET
        content_revoked_before = GREATEST(
          COALESCE(account_revocations.content_revoked_before, to_timestamp(0)),
          EXCLUDED.content_revoked_before
        ),
        updated_at = NOW()
    `,
    [account_id, new Date(content_revoked_before_ms)],
  );
}

// For password changes and "sign out other sessions": the change has already
// happened, so a failure to record the revocation is logged, not thrown.
export async function revokeContentLinksBestEffort(
  account_id: string,
): Promise<void> {
  try {
    await recordContentRevocation(account_id);
  } catch (err) {
    logger.error("could not revoke content links", {
      account_id,
      err: `${err}`,
    });
  }
}

// A password change (or passkey/2FA setup) ends every other sign-in session:
// other browsers' hub sessions and their open hub sockets, their sessions and
// tokens on project hosts, and every content link. This browser keeps its hub
// session and re-issues its host credentials.
//
// Order matters. The sessions end first, so no other browser can get a new
// host credential (issuing one re-checks the session). Then the host cutoff is
// now, to the millisecond: host credentials carry whole-second iat, so every
// credential issued in this second or before is refused, including any an
// attacker got earlier in this second. Last, wait until the next second, so
// what this browser re-issues after we return is newer than the cutoff.
export async function endOtherSessions({
  account_id,
  keep_session_hash,
  now = () => Date.now(),
  sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
}: {
  account_id: string;
  // Omitted (password reset): every sign-in session ends.
  keep_session_hash?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}): Promise<void> {
  if (!isValidUUID(account_id)) {
    throw new Error("invalid account_id");
  }
  const keep = `${keep_session_hash ?? ""}`.trim();
  if (keep) {
    await endOtherSignInSessions({ account_id, keep_session_hash: keep });
  } else {
    await endAllSignInSessions(account_id);
  }
  requestSignedOutSessionSweep();
  const cutoff_ms = now();
  await recordBrowserRevocation(account_id, cutoff_ms);
  const wait_ms = Math.floor(cutoff_ms / 1000) * 1000 + 1000 - now();
  if (wait_ms > 0) await sleep(wait_ms);
}

export async function recordBrowserRevocation(
  account_id: string,
  before_ms: number,
): Promise<void> {
  if (!isValidUUID(account_id)) {
    throw new Error("invalid account_id");
  }
  await ensureTable();
  const before = new Date(before_ms);
  await getPool().query(
    `
      INSERT INTO account_revocations(account_id, revoked_before, content_revoked_before, browser_revoked_before, updated_at)
      VALUES($1::UUID, to_timestamp(0), $2::TIMESTAMP, $2::TIMESTAMP, NOW())
      ON CONFLICT (account_id) DO UPDATE SET
        content_revoked_before = GREATEST(
          COALESCE(account_revocations.content_revoked_before, to_timestamp(0)),
          EXCLUDED.content_revoked_before
        ),
        browser_revoked_before = GREATEST(
          COALESCE(account_revocations.browser_revoked_before, to_timestamp(0)),
          EXCLUDED.browser_revoked_before
        ),
        updated_at = NOW()
    `,
    [account_id, before],
  );
}

// Callers have already changed the password or added a credential, so a
// failure says so plainly: silently leaving the other sessions signed in
// would be worse than an error.
export async function endOtherSessionsOrExplain(
  opts: Parameters<typeof endOtherSessions>[0],
): Promise<void> {
  try {
    await endOtherSessions(opts);
  } catch (err) {
    logger.error("could not end other sessions", {
      account_id: opts.account_id,
      err: `${err}`,
    });
    throw new Error(
      "The change was saved, but your other sessions could not be signed out. Use \"Sign out everywhere\" to sign them out.",
    );
  }
}

export async function listAccountRevocationsSince({
  cursor_updated_ms = 0,
  cursor_account_id = "",
  limit = 500,
}: {
  cursor_updated_ms?: number;
  cursor_account_id?: string;
  limit?: number;
}): Promise<
  Array<{
    account_id: string;
    revoked_before_ms: number;
    content_revoked_before_ms: number;
    browser_revoked_before_ms: number;
    updated_ms: number;
  }>
> {
  await ensureTable();
  const pool = getPool();
  const n = Number.isFinite(limit)
    ? Math.max(1, Math.min(5000, Math.floor(limit)))
    : 500;
  const cursorUpdated = new Date(Math.max(0, Number(cursor_updated_ms) || 0));
  const rows = (
    await pool.query<{
      account_id: string;
      revoked_before_ms: string | number;
      content_revoked_before_ms: string | number | null;
      browser_revoked_before_ms: string | number | null;
      updated_ms: string | number;
    }>(
      `
        SELECT
          account_id::text AS account_id,
          FLOOR(EXTRACT(EPOCH FROM revoked_before) * 1000)::bigint AS revoked_before_ms,
          FLOOR(EXTRACT(EPOCH FROM content_revoked_before) * 1000)::bigint AS content_revoked_before_ms,
          FLOOR(EXTRACT(EPOCH FROM browser_revoked_before) * 1000)::bigint AS browser_revoked_before_ms,
          FLOOR(EXTRACT(EPOCH FROM updated_at) * 1000)::bigint AS updated_ms
        FROM account_revocations
        WHERE
          (updated_at > $1::TIMESTAMP)
          OR (updated_at = $1::TIMESTAMP AND account_id::text > $2::text)
        ORDER BY updated_at ASC, account_id ASC
        LIMIT $3
      `,
      [cursorUpdated, cursor_account_id || "", n],
    )
  ).rows;
  return rows.map((row) => ({
    account_id: row.account_id,
    revoked_before_ms: Number(row.revoked_before_ms) || 0,
    content_revoked_before_ms: Number(row.content_revoked_before_ms) || 0,
    browser_revoked_before_ms: Number(row.browser_revoked_before_ms) || 0,
    updated_ms: Number(row.updated_ms) || 0,
  }));
}

export async function getAccountRevocationBefore(
  account_id: string,
): Promise<number | undefined> {
  if (!isValidUUID(account_id)) {
    return;
  }
  await ensureTable();
  const pool = getPool();
  const row = (
    await pool.query<{ revoked_before_ms: string | number }>(
      `
        SELECT FLOOR(EXTRACT(EPOCH FROM revoked_before) * 1000)::bigint AS revoked_before_ms
        FROM account_revocations
        WHERE account_id=$1::UUID
        LIMIT 1
      `,
      [account_id],
    )
  ).rows[0];
  const ms = Number(row?.revoked_before_ms);
  return Number.isFinite(ms) ? ms : undefined;
}
