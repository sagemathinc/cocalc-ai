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
import { getRememberMeHash } from "@cocalc/server/auth/remember-me";
import { getImpersonationSessionBySessionHash } from "@cocalc/server/auth/impersonation";
import { isValidUUID } from "@cocalc/util/misc";

export type SecondFactorMethod = "totp" | "recovery_code";
export type AuthSessionFactorLevel = "none" | SecondFactorMethod;
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
        $7::TIMESTAMP,
        $8::VARCHAR(32),
        $9::INET,
        $10::TEXT,
        NULL,
        $11::JSONB
      )
      ON CONFLICT (session_hash) DO UPDATE SET
        account_id = EXCLUDED.account_id,
        updated = NOW(),
        expire = EXCLUDED.expire,
        authenticated_at = EXCLUDED.authenticated_at,
        password_verified_at = EXCLUDED.password_verified_at,
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
  password_verified_at = authenticated_at,
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
  const session_hash = getRememberMeHash(req);
  if (!session_hash) {
    throw new Error("browser sign-in is required");
  }
  const row = await ensureAuthSessionForRememberMeHash({ session_hash, req });
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
}: {
  req: Request;
  account_id: string;
  factor_level: AuthSessionFactorLevel;
  fresh_auth_until: Date;
}): Promise<void> {
  const session_hash = getRememberMeHash(req);
  if (!session_hash) {
    throw new Error("browser sign-in is required");
  }
  await setSessionFreshAuth({
    account_id,
    session_hash,
    factor_level,
    fresh_auth_until,
  });
}

export async function setSessionFreshAuth({
  account_id,
  session_hash,
  factor_level,
  fresh_auth_until,
}: {
  account_id: string;
  session_hash: string;
  factor_level: AuthSessionFactorLevel;
  fresh_auth_until: Date;
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
      await db.query(
        `
          UPDATE account_auth_sessions
             SET updated = NOW(),
                 password_verified_at = NOW(),
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
                 revoked_at = NULL
           WHERE session_hash = $1::CHAR(127)
        `,
        [cleanedSessionHash, fresh_auth_until, factor_level],
      );
    },
  });
}

export async function revokeAuthSession({
  account_id,
  session_hash,
}: {
  account_id: string;
  session_hash: string;
}): Promise<void> {
  await withAccountRehomeWriteFence({
    account_id,
    action: "revoke auth session",
    fn: async (db) => {
      await db.query(
        `
          UPDATE account_auth_sessions
             SET updated = NOW(), revoked_at = NOW()
           WHERE session_hash = $1::CHAR(127)
        `,
        [session_hash],
      );
    },
  });
}

export async function revokeAllAuthSessions(account_id: string): Promise<void> {
  await withAccountRehomeWriteFence({
    account_id,
    action: "revoke all auth sessions",
    fn: async (db) => {
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

export async function revokeOtherAuthSessions({
  account_id,
  keep_session_hash,
}: {
  account_id: string;
  keep_session_hash: string;
}): Promise<void> {
  await withAccountRehomeWriteFence({
    account_id,
    action: "revoke other auth sessions",
    fn: async (db) => {
      await db.query(
        `
          UPDATE account_auth_sessions
             SET updated = NOW(), revoked_at = NOW()
           WHERE account_id = $1::UUID
             AND session_hash <> $2::CHAR(127)
             AND revoked_at IS NULL
        `,
        [account_id, keep_session_hash],
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
    if (factor_level !== "totp") {
      throw new Error(
        "extended fresh auth requires a TOTP verification in this browser session",
      );
    }
    return FRESH_AUTH_EXTENDED_MS;
  }
  return FRESH_AUTH_DEFAULT_MS;
}
