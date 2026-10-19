/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Request } from "express";

import getPool from "@cocalc/database/pool";
import {
  withAccountRehomeWriteFence,
  assertAccountWriteOnHomeBay,
} from "@cocalc/server/accounts/rehome-fence";
import { getRememberMeHashes } from "@cocalc/server/auth/remember-me";
import { getImpersonationSessionBySessionHash } from "@cocalc/server/auth/impersonation";
import { renewSessionLifetime } from "@cocalc/server/auth/session-expiry";
import { isValidUUID } from "@cocalc/util/misc";

export type SecondFactorMethod = "totp" | "recovery_code" | "passkey";
export type PasswordFreshAuthFactorLevel = "none" | SecondFactorMethod;
export type SsoFreshAuthMethod = "google_oidc";
export type AuthPrimaryMethod =
  | "password"
  | "email_code"
  | "email_link"
  | "google_oidc"
  | "saml"
  | "legacy_sso"
  | "admin";
export type AuthSessionFactorLevel =
  | PasswordFreshAuthFactorLevel
  | SsoFreshAuthMethod;
export type FreshAuthDuration = "default" | "extended";

export const FRESH_AUTH_DEFAULT_MS = 15 * 60_000;
export const FRESH_AUTH_EXTENDED_MS = 8 * 60 * 60_000;

type Queryable = {
  query: <T = any>(
    sql: string,
    params?: any[],
  ) => Promise<{ rows: T[]; rowCount?: number | null }>;
};

export interface AccountAuthSessionRow {
  session_hash: string;
  account_id: string;
  created?: Date;
  updated?: Date;
  expire?: Date;
  authenticated_at?: Date;
  password_verified_at?: Date | null;
  primary_verified_at?: Date | null;
  primary_auth_method?: AuthPrimaryMethod | null;
  factor_verified_at?: Date | null;
  fresh_auth_until?: Date | null;
  factor_level?: AuthSessionFactorLevel;
  ip_address?: string | null;
  user_agent?: string | null;
  revoked_at?: Date | null;
  metadata?: Record<string, unknown> | null;
}

function cleanUserAgent(value: string | undefined): string {
  const userAgent = `${value ?? ""}`.trim();
  return userAgent.length > 1024 ? userAgent.slice(0, 1024) : userAgent;
}

function cleanIpAddress(value: string | undefined): string | null {
  const ip = `${value ?? ""}`.trim();
  return ip || null;
}

async function upsertAuthSessionWithDb({
  db,
  session_hash,
  account_id,
  expire,
  authenticated_at,
  password_verified_at,
  primary_verified_at,
  primary_auth_method,
  factor_verified_at,
  fresh_auth_until,
  factor_level,
  ip_address,
  user_agent,
  metadata,
}: {
  db: Queryable;
  session_hash: string;
  account_id: string;
  expire: Date;
  authenticated_at: Date;
  password_verified_at?: Date | null;
  primary_verified_at?: Date | null;
  primary_auth_method?: AuthPrimaryMethod | null;
  factor_verified_at?: Date | null;
  fresh_auth_until?: Date | null;
  factor_level?: AuthSessionFactorLevel;
  ip_address?: string | null;
  user_agent?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await db.query(
    `
      INSERT INTO account_auth_sessions (
        session_hash,
        account_id,
        created,
        updated,
        expire,
        authenticated_at,
        password_verified_at,
        primary_verified_at,
        primary_auth_method,
        factor_verified_at,
        fresh_auth_until,
        factor_level,
        ip_address,
        user_agent,
        revoked_at,
        metadata
      ) VALUES (
        $1::CHAR(127),
        $2::UUID,
        NOW(),
        NOW(),
        $3::TIMESTAMP,
        $4::TIMESTAMP,
        $5::TIMESTAMP,
        $6::TIMESTAMP,
        $7::VARCHAR(32),
        $8::TIMESTAMP,
        $9::TIMESTAMP,
        $10::VARCHAR(32),
        $11::INET,
        $12::TEXT,
        NULL,
        $13::JSONB
      )
      ON CONFLICT (session_hash) DO UPDATE SET
        account_id = EXCLUDED.account_id,
        updated = NOW(),
        expire = EXCLUDED.expire,
        authenticated_at = EXCLUDED.authenticated_at,
        password_verified_at = EXCLUDED.password_verified_at,
        primary_verified_at = EXCLUDED.primary_verified_at,
        primary_auth_method = EXCLUDED.primary_auth_method,
        factor_verified_at = EXCLUDED.factor_verified_at,
        fresh_auth_until = EXCLUDED.fresh_auth_until,
        factor_level = EXCLUDED.factor_level,
        ip_address = EXCLUDED.ip_address,
        user_agent = EXCLUDED.user_agent,
        revoked_at = NULL,
        metadata = EXCLUDED.metadata
    `,
    [
      session_hash,
      account_id,
      expire,
      authenticated_at,
      password_verified_at ?? null,
      primary_verified_at ?? password_verified_at ?? null,
      primary_auth_method ?? (password_verified_at ? "password" : null),
      factor_verified_at ?? null,
      fresh_auth_until ?? null,
      factor_level ?? "none",
      ip_address ?? null,
      user_agent ?? null,
      JSON.stringify(metadata ?? {}),
    ],
  );
}

export async function recordNewAuthSession({
  account_id,
  session_hash,
  expire,
  req,
  authenticated_at = new Date(),
  password_verified_at,
  primary_verified_at,
  primary_auth_method,
  factor_verified_at,
  factor_level = "none",
  fresh_auth_until,
  metadata,
}: {
  account_id: string;
  session_hash: string;
  expire: Date;
  req?: Request;
  authenticated_at?: Date;
  password_verified_at?: Date | null;
  primary_verified_at?: Date | null;
  primary_auth_method?: AuthPrimaryMethod | null;
  factor_verified_at?: Date | null;
  factor_level?: AuthSessionFactorLevel;
  fresh_auth_until?: Date | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await withAccountRehomeWriteFence({
    account_id,
    action: "record auth session",
    fn: async (db) => {
      await upsertAuthSessionWithDb({
        db,
        account_id,
        session_hash,
        expire,
        authenticated_at,
        password_verified_at,
        primary_verified_at,
        primary_auth_method,
        factor_verified_at,
        fresh_auth_until,
        factor_level,
        ip_address: cleanIpAddress(req?.ip),
        user_agent: cleanUserAgent(req?.get("user-agent")),
        metadata,
      });
    },
  });
}

export async function getAuthSession(
  session_hash: string,
): Promise<AccountAuthSessionRow | undefined> {
  const row = (
    await getPool().query<AccountAuthSessionRow>(
      `
        SELECT *
          FROM account_auth_sessions
         WHERE session_hash = $1::CHAR(127)
         LIMIT 1
      `,
      [session_hash],
    )
  ).rows[0];
  return row;
}

async function getRememberMeRow(session_hash: string): Promise<{
  account_id: string;
  expire: Date;
} | null> {
  const row = (
    await getPool().query<{ account_id: string; expire: Date }>(
      `
        SELECT account_id, expire
          FROM remember_me
         WHERE hash = $1::CHAR(127)
         LIMIT 1
      `,
      [session_hash],
    )
  ).rows[0];
  if (!row?.account_id) {
    return null;
  }
  return {
    account_id: row.account_id,
    expire: row.expire,
  };
}

export async function ensureAuthSessionForRememberMeHash({
  session_hash,
  req,
}: {
  session_hash: string;
  req?: Request;
}): Promise<AccountAuthSessionRow | undefined> {
  const existing = await getAuthSession(session_hash);
  if (existing) {
    return existing;
  }
  const rememberMe = await getRememberMeRow(session_hash);
  if (!rememberMe) {
    return;
  }
  await withAccountRehomeWriteFence({
    account_id: rememberMe.account_id,
    action: "backfill auth session",
    fn: async (db) => {
      await upsertAuthSessionWithDb({
        db,
        account_id: rememberMe.account_id,
        session_hash,
        expire: rememberMe.expire,
        authenticated_at: new Date(),
        password_verified_at: null,
        factor_verified_at: null,
        fresh_auth_until: null,
        factor_level: "none",
        ip_address: cleanIpAddress(req?.ip),
        user_agent: cleanUserAgent(req?.get("user-agent")),
        metadata: { backfilled: true },
      });
    },
  });
  return await getAuthSession(session_hash);
}

export async function getCurrentAuthSession({
  req,
  account_id,
}: {
  req: Request;
  account_id: string;
}): Promise<AccountAuthSessionRow> {
  if (!isValidUUID(account_id)) {
    throw new Error("invalid account_id");
  }
  const session_hashes = getRememberMeHashes(req);
  if (session_hashes.length === 0) {
    throw new Error("browser sign-in is required");
  }
  for (const session_hash of session_hashes) {
    const row = await ensureAuthSessionForRememberMeHash({ session_hash, req });
    if (!row || row.account_id !== account_id) {
      continue;
    }
    if (row.revoked_at) {
      throw new Error("current browser session has been revoked");
    }
    if (row.expire && new Date(row.expire).valueOf() <= Date.now()) {
      throw new Error("current browser session has expired");
    }
    return row;
  }
  throw new Error("current browser session not found");
}

export async function getCurrentAuthSessionForSessionHash({
  session_hash,
  account_id,
}: {
  session_hash: string;
  account_id: string;
}): Promise<AccountAuthSessionRow> {
  if (!isValidUUID(account_id)) {
    throw new Error("invalid account_id");
  }
  const cleanedSessionHash = `${session_hash ?? ""}`.trim();
  if (!cleanedSessionHash) {
    throw new Error("browser sign-in is required");
  }
  const row = await ensureAuthSessionForRememberMeHash({
    session_hash: cleanedSessionHash,
  });
  if (!row || row.account_id !== account_id) {
    throw new Error("current browser session not found");
  }
  if (row.revoked_at) {
    throw new Error("current browser session has been revoked");
  }
  if (row.expire && new Date(row.expire).valueOf() <= Date.now()) {
    throw new Error("current browser session has expired");
  }
  return row;
}

export async function setCurrentSessionFreshAuth({
  req,
  account_id,
  factor_level,
  fresh_auth_until,
  metadata_patch,
  primary_auth_method = "password",
  primary_verified_at = new Date(),
}: {
  req: Request;
  account_id: string;
  factor_level: AuthSessionFactorLevel;
  fresh_auth_until: Date;
  metadata_patch?: Record<string, unknown>;
  primary_auth_method?: AuthPrimaryMethod;
  primary_verified_at?: Date;
}): Promise<void> {
  const session_hash = (await getCurrentAuthSession({ req, account_id }))
    .session_hash;
  if (!session_hash) {
    throw new Error("browser sign-in is required");
  }
  await setSessionFreshAuth({
    account_id,
    session_hash,
    factor_level,
    fresh_auth_until,
    metadata_patch,
    primary_auth_method,
    primary_verified_at,
  });
}

export async function setSessionFreshAuth({
  account_id,
  session_hash,
  factor_level,
  fresh_auth_until,
  metadata_patch,
  primary_auth_method = "password",
  primary_verified_at = new Date(),
}: {
  account_id: string;
  session_hash: string;
  factor_level: AuthSessionFactorLevel;
  fresh_auth_until: Date;
  metadata_patch?: Record<string, unknown>;
  primary_auth_method?: AuthPrimaryMethod;
  primary_verified_at?: Date;
}): Promise<void> {
  const cleanedSessionHash = `${session_hash ?? ""}`.trim();
  if (!cleanedSessionHash) {
    throw new Error("session_hash is required");
  }
  await withAccountRehomeWriteFence({
    account_id,
    action: "set fresh auth",
    fn: async (db) => {
      await assertAccountWriteOnHomeBay({
        db,
        account_id,
        action: "set fresh auth",
      });
      const { rowCount } = await db.query(
        `
          UPDATE account_auth_sessions
             SET updated = NOW(),
                 password_verified_at =
                   CASE
                     WHEN $6::VARCHAR(32) = 'password' THEN $7::TIMESTAMP
                     ELSE password_verified_at
                   END,
                 primary_verified_at = $7::TIMESTAMP,
                 primary_auth_method = $6::VARCHAR(32),
                 factor_verified_at =
                   CASE
                     WHEN $3::VARCHAR(32) = 'none' THEN factor_verified_at
                     ELSE NOW()
                   END,
                 fresh_auth_until = $2::TIMESTAMP,
                 factor_level =
                   CASE
                     WHEN $3::VARCHAR(32) = 'none' THEN factor_level
                     ELSE $3::VARCHAR(32)
                   END,
                 metadata = COALESCE(metadata, '{}'::JSONB) || $4::JSONB
           WHERE session_hash = $1::CHAR(127)
             AND account_id = $5::UUID
             AND revoked_at IS NULL
             AND expire > NOW()
        `,
        [
          cleanedSessionHash,
          fresh_auth_until,
          factor_level,
          JSON.stringify(metadata_patch ?? {}),
          account_id,
          primary_auth_method,
          primary_verified_at,
        ],
      );
      if ((rowCount ?? 0) === 0) {
        throw new Error("current browser session not found");
      }
      // Re-entering the password or second factor starts a new maximum
      // lifetime for this session, so an active person is never forced to
      // sign in again mid-use. An impersonation session keeps its own short
      // lifetime.
      const impersonation = await db.query(
        "SELECT 1 FROM account_impersonation_sessions WHERE session_hash = $1::CHAR(127) LIMIT 1",
        [cleanedSessionHash],
      );
      if (impersonation.rows.length === 0) {
        await renewSessionLifetime({
          db,
          hash: cleanedSessionHash,
          account_id,
        });
      }
    },
  });
}

// Ending sign-in sessions deletes their remember_me rows (the cookie stops
// working) and revokes their auth sessions together, in one transaction
// inside the account rehome fence. Both rows move with the account when it is
// rehomed, so neither may change while a rehome copies them: a delete that
// landed after the copy read the rows would bring the session back on the
// new bay.

async function sessionAccountId(
  session_hash: string,
): Promise<string | undefined> {
  const { rows } = await getPool().query(
    `
      SELECT account_id FROM remember_me WHERE hash = $1::CHAR(127)
      UNION ALL
      SELECT account_id FROM account_auth_sessions
       WHERE session_hash = $1::CHAR(127)
      LIMIT 1
    `,
    [session_hash],
  );
  return rows[0]?.account_id ?? undefined;
}

// End one sign-in session. Without account_id, the session's own account.
export async function endSignInSession({
  session_hash,
  account_id,
}: {
  session_hash: string;
  account_id?: string;
}): Promise<void> {
  const hash = `${session_hash ?? ""}`.trim().slice(0, 127);
  if (!hash) return;
  const owner = account_id ?? (await sessionAccountId(hash));
  if (!owner) return;
  await withAccountRehomeWriteFence({
    account_id: owner,
    action: "end sign-in session",
    fn: async (db) => {
      await db.query(
        `
          DELETE FROM remember_me
           WHERE hash = $1::CHAR(127)
             AND account_id = $2::UUID
        `,
        [hash, owner],
      );
      await db.query(
        `
          UPDATE account_auth_sessions
             SET updated = NOW(), revoked_at = NOW()
           WHERE session_hash = $1::CHAR(127)
             AND account_id = $2::UUID
        `,
        [hash, owner],
      );
    },
  });
}

export async function endAllSignInSessions(account_id: string): Promise<void> {
  await withAccountRehomeWriteFence({
    account_id,
    action: "end all sign-in sessions",
    fn: async (db) => {
      await db.query("DELETE FROM remember_me WHERE account_id = $1::UUID", [
        account_id,
      ]);
      await db.query(
        `
          UPDATE account_auth_sessions
             SET updated = NOW(), revoked_at = NOW()
           WHERE account_id = $1::UUID
             AND revoked_at IS NULL
        `,
        [account_id],
      );
    },
  });
}

export async function endOtherSignInSessions({
  account_id,
  keep_session_hash,
}: {
  account_id: string;
  keep_session_hash: string;
}): Promise<void> {
  const keep = `${keep_session_hash ?? ""}`.trim().slice(0, 127);
  if (!keep) throw new Error("keep_session_hash is required");
  await withAccountRehomeWriteFence({
    account_id,
    action: "end other sign-in sessions",
    fn: async (db) => {
      await db.query(
        `
          DELETE FROM remember_me
           WHERE account_id = $1::UUID
             AND hash <> $2::CHAR(127)
        `,
        [account_id, keep],
      );
      await db.query(
        `
          UPDATE account_auth_sessions
             SET updated = NOW(), revoked_at = NOW()
           WHERE account_id = $1::UUID
             AND session_hash <> $2::CHAR(127)
             AND revoked_at IS NULL
        `,
        [account_id, keep],
      );
    },
  });
}

export async function requireFreshAuth({
  req,
  account_id,
  allow_actor_impersonation = false,
}: {
  req: Request;
  account_id: string;
  allow_actor_impersonation?: boolean;
}): Promise<AccountAuthSessionRow> {
  // Browser-facing routes that call requireFreshAuth must have matching React
  // wiring through useFreshAuthAction/FreshAuthModal. Otherwise stale sessions
  // fail as raw API errors instead of prompting the user to verify and retry.
  // Non-browser callers should document why a frontend counterpart is not
  // needed, e.g. dev CLI fresh auth or internal maintenance code.
  const session = await getCurrentAuthSession({ req, account_id });
  if (allow_actor_impersonation) {
    const impersonation = await getImpersonationSessionBySessionHash({
      session_hash: session.session_hash,
      subject_account_id: account_id,
    });
    if (impersonation) {
      if (!impersonation.actor_fresh_auth_until) {
        throw Object.assign(new Error("fresh auth is required"), {
          code: "fresh_auth_required",
        });
      }
      if (
        new Date(impersonation.actor_fresh_auth_until).valueOf() < Date.now()
      ) {
        throw Object.assign(new Error("fresh auth is required"), {
          code: "fresh_auth_required",
        });
      }
      return session;
    }
  }
  if (!session.fresh_auth_until) {
    throw Object.assign(new Error("fresh auth is required"), {
      code: "fresh_auth_required",
    });
  }
  if (new Date(session.fresh_auth_until).valueOf() < Date.now()) {
    throw Object.assign(new Error("fresh auth is required"), {
      code: "fresh_auth_required",
    });
  }
  return session;
}

export async function requireFreshAuthForSessionHash({
  session_hash,
  account_id,
  allow_actor_impersonation = false,
}: {
  session_hash: string;
  account_id: string;
  allow_actor_impersonation?: boolean;
}): Promise<AccountAuthSessionRow> {
  // Same frontend rule as requireFreshAuth when this protects browser-triggered
  // Conat/RPC actions: wire the React caller through useFreshAuthAction and
  // render FreshAuthModal so the protected action can be retried after verify.
  const session = await getCurrentAuthSessionForSessionHash({
    session_hash,
    account_id,
  });
  if (allow_actor_impersonation) {
    const impersonation = await getImpersonationSessionBySessionHash({
      session_hash,
      subject_account_id: account_id,
    });
    if (impersonation) {
      if (!impersonation.actor_fresh_auth_until) {
        throw Object.assign(new Error("fresh auth is required"), {
          code: "fresh_auth_required",
        });
      }
      if (
        new Date(impersonation.actor_fresh_auth_until).valueOf() < Date.now()
      ) {
        throw Object.assign(new Error("fresh auth is required"), {
          code: "fresh_auth_required",
        });
      }
      return session;
    }
  }
  if (!session.fresh_auth_until) {
    throw Object.assign(new Error("fresh auth is required"), {
      code: "fresh_auth_required",
    });
  }
  if (new Date(session.fresh_auth_until).valueOf() < Date.now()) {
    throw Object.assign(new Error("fresh auth is required"), {
      code: "fresh_auth_required",
    });
  }
  return session;
}

export function resolveFreshAuthDurationMs({
  duration,
  factor_level,
}: {
  duration?: FreshAuthDuration;
  factor_level: AuthSessionFactorLevel;
}): number {
  if (duration === "extended") {
    if (
      factor_level !== "totp" &&
      factor_level !== "passkey" &&
      factor_level !== "google_oidc"
    ) {
      throw new Error(
        "extended fresh auth requires a TOTP, passkey, or Google verification in this browser session",
      );
    }
    return FRESH_AUTH_EXTENDED_MS;
  }
  return FRESH_AUTH_DEFAULT_MS;
}
