/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { v4 as uuid } from "uuid";
import type { Request } from "express";

import getPool from "@cocalc/database/pool";
import centralLog from "@cocalc/database/postgres/central-log";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  assertAccountWriteOnHomeBay,
  withAccountRehomeWriteFence,
} from "@cocalc/server/accounts/rehome-fence";
import { getRememberMeHash } from "@cocalc/server/auth/remember-me";
import type { AuthSessionFactorLevel } from "@cocalc/server/auth/auth-sessions";
import { isValidUUID } from "@cocalc/util/misc";

const IMPERSONATION_GRANT_TTL_MS = 10 * 60_000;
const IMPERSONATION_STATUS_ACTIVE = "active";
const IMPERSONATION_STATUS_ENDED = "ended";

export interface ImpersonationGrantRow {
  id: string;
  subject_account_id: string;
  actor_account_id: string;
  created?: Date;
  expire: Date;
  consumed_at?: Date | null;
  revoked_at?: Date | null;
  created_on_bay_id?: string | null;
  subject_home_bay_id?: string | null;
  actor_session_hash?: string | null;
  actor_authenticated_at?: Date | null;
  actor_password_verified_at?: Date | null;
  actor_factor_verified_at?: Date | null;
  actor_fresh_auth_until?: Date | null;
  actor_factor_level?: AuthSessionFactorLevel | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ImpersonationSessionRow {
  session_hash: string;
  subject_account_id: string;
  actor_account_id: string;
  grant_id: string;
  created?: Date;
  updated?: Date;
  expire: Date;
  actor_authenticated_at?: Date | null;
  actor_password_verified_at?: Date | null;
  actor_factor_verified_at?: Date | null;
  actor_fresh_auth_until?: Date | null;
  actor_factor_level?: AuthSessionFactorLevel | null;
  status: string;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ImpersonationBootstrapInfo {
  active: true;
  actor_account_id: string;
  actor_email_address?: string | null;
  actor_name?: string | null;
  subject_account_id: string;
  fresh_auth_until?: Date | null;
  factor_level?: AuthSessionFactorLevel | null;
}

function ensureUuid(name: string, value: string): string {
  const normalized = `${value ?? ""}`.trim();
  if (!isValidUUID(normalized)) {
    throw new Error(`${name} must be a uuid`);
  }
  return normalized;
}

function normalizeReason(value?: string | null): string | null {
  const reason = `${value ?? ""}`.trim();
  return reason ? reason.slice(0, 512) : null;
}

function normalizeMetadata(
  metadata?: Record<string, unknown> | null,
): Record<string, unknown> {
  return metadata && typeof metadata === "object" ? metadata : {};
}

function activeSession(
  row?: ImpersonationSessionRow | null,
): ImpersonationSessionRow | undefined {
  if (!row) {
    return;
  }
  if (row.status !== IMPERSONATION_STATUS_ACTIVE) {
    return;
  }
  if (row.expire && new Date(row.expire).valueOf() <= Date.now()) {
    return;
  }
  return row;
}

async function getAccountSummary(account_id: string): Promise<{
  email_address?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}> {
  const row = (
    await getPool().query<{
      email_address?: string | null;
      first_name?: string | null;
      last_name?: string | null;
    }>(
      `
        SELECT email_address, first_name, last_name
          FROM accounts
         WHERE account_id = $1::UUID
         LIMIT 1
      `,
      [account_id],
    )
  ).rows[0];
  return row ?? {};
}

export async function createImpersonationGrantLocal({
  actor_account_id,
  subject_account_id,
  actor_session_hash,
  subject_home_bay_id,
  actor_authenticated_at,
  actor_password_verified_at,
  actor_factor_verified_at,
  actor_fresh_auth_until,
  actor_factor_level,
  reason,
  metadata,
}: {
  actor_account_id: string;
  subject_account_id: string;
  actor_session_hash: string;
  subject_home_bay_id: string;
  actor_authenticated_at?: Date | null;
  actor_password_verified_at?: Date | null;
  actor_factor_verified_at?: Date | null;
  actor_fresh_auth_until?: Date | null;
  actor_factor_level?: AuthSessionFactorLevel | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<ImpersonationGrantRow> {
  const actorAccountId = ensureUuid("actor_account_id", actor_account_id);
  const subjectAccountId = ensureUuid("subject_account_id", subject_account_id);
  const sessionHash = `${actor_session_hash ?? ""}`.trim();
  const homeBayId = `${subject_home_bay_id ?? ""}`.trim();
  if (!sessionHash) {
    throw new Error("actor_session_hash is required");
  }
  if (!homeBayId) {
    throw new Error("subject_home_bay_id is required");
  }
  const grant: ImpersonationGrantRow = {
    id: uuid(),
    actor_account_id: actorAccountId,
    subject_account_id: subjectAccountId,
    expire: new Date(Date.now() + IMPERSONATION_GRANT_TTL_MS),
    created_on_bay_id: getConfiguredBayId(),
    subject_home_bay_id: homeBayId,
    actor_session_hash: sessionHash,
    actor_authenticated_at: actor_authenticated_at ?? null,
    actor_password_verified_at: actor_password_verified_at ?? null,
    actor_factor_verified_at: actor_factor_verified_at ?? null,
    actor_fresh_auth_until: actor_fresh_auth_until ?? null,
    actor_factor_level: actor_factor_level ?? "none",
    reason: normalizeReason(reason),
    metadata: normalizeMetadata(metadata),
  };
  await withAccountRehomeWriteFence({
    account_id: subjectAccountId,
    action: "create impersonation grant",
    fn: async (db) => {
      await assertAccountWriteOnHomeBay({
        db,
        account_id: subjectAccountId,
        action: "create impersonation grant",
      });
      await db.query(
        `
          INSERT INTO account_impersonation_grants (
            id,
            subject_account_id,
            actor_account_id,
            created,
            expire,
            consumed_at,
            revoked_at,
            created_on_bay_id,
            subject_home_bay_id,
            actor_session_hash,
            actor_authenticated_at,
            actor_password_verified_at,
            actor_factor_verified_at,
            actor_fresh_auth_until,
            actor_factor_level,
            reason,
            metadata
          ) VALUES (
            $1::UUID,
            $2::UUID,
            $3::UUID,
            NOW(),
            $4::TIMESTAMP,
            NULL,
            NULL,
            $5::TEXT,
            $6::TEXT,
            $7::CHAR(127),
            $8::TIMESTAMP,
            $9::TIMESTAMP,
            $10::TIMESTAMP,
            $11::TIMESTAMP,
            $12::VARCHAR(32),
            $13::TEXT,
            $14::JSONB
          )
        `,
        [
          grant.id,
          subjectAccountId,
          actorAccountId,
          grant.expire,
          grant.created_on_bay_id,
          grant.subject_home_bay_id,
          grant.actor_session_hash,
          grant.actor_authenticated_at,
          grant.actor_password_verified_at,
          grant.actor_factor_verified_at,
          grant.actor_fresh_auth_until,
          grant.actor_factor_level,
          grant.reason,
          JSON.stringify(grant.metadata ?? {}),
        ],
      );
    },
  });
  await centralLog({
    event: "impersonation-grant-created",
    value: {
      actor_account_id: actorAccountId,
      subject_account_id: subjectAccountId,
      grant_id: grant.id,
      subject_home_bay_id: homeBayId,
      reason: grant.reason,
    },
  });
  return grant;
}

export async function getImpersonationGrant(
  grant_id: string,
): Promise<ImpersonationGrantRow | undefined> {
  const grantId = ensureUuid("grant_id", grant_id);
  return (
    await getPool().query<ImpersonationGrantRow>(
      `
        SELECT *
          FROM account_impersonation_grants
         WHERE id = $1::UUID
         LIMIT 1
      `,
      [grantId],
    )
  ).rows[0];
}

export async function consumeImpersonationGrantLocal({
  grant_id,
  subject_account_id,
}: {
  grant_id: string;
  subject_account_id: string;
}): Promise<ImpersonationGrantRow> {
  const grantId = ensureUuid("grant_id", grant_id);
  const subjectAccountId = ensureUuid("subject_account_id", subject_account_id);
  let grant: ImpersonationGrantRow | undefined;
  await withAccountRehomeWriteFence({
    account_id: subjectAccountId,
    action: "consume impersonation grant",
    fn: async (db) => {
      await assertAccountWriteOnHomeBay({
        db,
        account_id: subjectAccountId,
        action: "consume impersonation grant",
      });
      const { rows } = (await db.query(
        `
          UPDATE account_impersonation_grants
             SET consumed_at = NOW()
           WHERE id = $1::UUID
             AND subject_account_id = $2::UUID
             AND revoked_at IS NULL
             AND consumed_at IS NULL
             AND expire > NOW()
         RETURNING *
        `,
        [grantId, subjectAccountId],
      )) as { rows: ImpersonationGrantRow[] };
      grant = rows[0];
    },
  });
  if (!grant) {
    throw new Error("invalid or expired impersonation grant");
  }
  await centralLog({
    event: "impersonation-grant-consumed",
    value: {
      actor_account_id: grant.actor_account_id,
      subject_account_id: grant.subject_account_id,
      grant_id: grant.id,
    },
  });
  return grant;
}

export async function createImpersonationSessionLocal({
  session_hash,
  expire,
  grant,
  metadata,
}: {
  session_hash: string;
  expire: Date;
  grant: ImpersonationGrantRow;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  const sessionHash = `${session_hash ?? ""}`.trim();
  if (!sessionHash) {
    throw new Error("session_hash is required");
  }
  const subjectAccountId = ensureUuid(
    "subject_account_id",
    grant.subject_account_id,
  );
  await withAccountRehomeWriteFence({
    account_id: subjectAccountId,
    action: "create impersonation session",
    fn: async (db) => {
      await assertAccountWriteOnHomeBay({
        db,
        account_id: subjectAccountId,
        action: "create impersonation session",
      });
      await db.query(
        `
          INSERT INTO account_impersonation_sessions (
            session_hash,
            subject_account_id,
            actor_account_id,
            grant_id,
            created,
            updated,
            expire,
            actor_authenticated_at,
            actor_password_verified_at,
            actor_factor_verified_at,
            actor_fresh_auth_until,
            actor_factor_level,
            status,
            reason,
            metadata
          ) VALUES (
            $1::CHAR(127),
            $2::UUID,
            $3::UUID,
            $4::UUID,
            NOW(),
            NOW(),
            $5::TIMESTAMP,
            $6::TIMESTAMP,
            $7::TIMESTAMP,
            $8::TIMESTAMP,
            $9::TIMESTAMP,
            $10::VARCHAR(32),
            $11::VARCHAR(32),
            $12::TEXT,
            $13::JSONB
          )
          ON CONFLICT (session_hash) DO UPDATE SET
            subject_account_id = EXCLUDED.subject_account_id,
            actor_account_id = EXCLUDED.actor_account_id,
            grant_id = EXCLUDED.grant_id,
            updated = NOW(),
            expire = EXCLUDED.expire,
            actor_authenticated_at = EXCLUDED.actor_authenticated_at,
            actor_password_verified_at = EXCLUDED.actor_password_verified_at,
            actor_factor_verified_at = EXCLUDED.actor_factor_verified_at,
            actor_fresh_auth_until = EXCLUDED.actor_fresh_auth_until,
            actor_factor_level = EXCLUDED.actor_factor_level,
            status = EXCLUDED.status,
            reason = EXCLUDED.reason,
            metadata = EXCLUDED.metadata
        `,
        [
          sessionHash,
          subjectAccountId,
          grant.actor_account_id,
          grant.id,
          expire,
          grant.actor_authenticated_at ?? null,
          grant.actor_password_verified_at ?? null,
          grant.actor_factor_verified_at ?? null,
          grant.actor_fresh_auth_until ?? null,
          grant.actor_factor_level ?? "none",
          IMPERSONATION_STATUS_ACTIVE,
          grant.reason ?? null,
          JSON.stringify({
            ...(grant.metadata ?? {}),
            ...(metadata ?? {}),
          }),
        ],
      );
    },
  });
  await centralLog({
    event: "impersonation-session-created",
    value: {
      actor_account_id: grant.actor_account_id,
      subject_account_id: grant.subject_account_id,
      grant_id: grant.id,
      session_hash: sessionHash,
    },
  });
}

export async function getImpersonationSessionBySessionHash({
  session_hash,
  subject_account_id,
}: {
  session_hash: string;
  subject_account_id?: string;
}): Promise<ImpersonationSessionRow | undefined> {
  const cleaned = `${session_hash ?? ""}`.trim();
  if (!cleaned) {
    return;
  }
  const params: any[] = [cleaned];
  const subjectFilter =
    subject_account_id && isValidUUID(`${subject_account_id ?? ""}`.trim())
      ? (() => {
          params.push(subject_account_id);
          return "AND subject_account_id = $2::UUID";
        })()
      : "";
  return activeSession(
    (
      await getPool().query<ImpersonationSessionRow>(
        `
          SELECT *
            FROM account_impersonation_sessions
           WHERE session_hash = $1::CHAR(127)
             ${subjectFilter}
           LIMIT 1
        `,
        params,
      )
    ).rows[0],
  );
}

export async function getCurrentImpersonationSession({
  req,
  account_id,
}: {
  req: Request;
  account_id: string;
}): Promise<ImpersonationSessionRow | undefined> {
  const session_hash = getRememberMeHash(req);
  if (!session_hash) {
    return;
  }
  return await getImpersonationSessionBySessionHash({
    session_hash,
    subject_account_id: account_id,
  });
}

export async function setImpersonationActorFreshAuth({
  subject_account_id,
  session_hash,
  factor_level,
  fresh_auth_until,
}: {
  subject_account_id: string;
  session_hash: string;
  factor_level: AuthSessionFactorLevel;
  fresh_auth_until: Date;
}): Promise<void> {
  const subjectAccountId = ensureUuid("subject_account_id", subject_account_id);
  const sessionHash = `${session_hash ?? ""}`.trim();
  if (!sessionHash) {
    throw new Error("session_hash is required");
  }
  await withAccountRehomeWriteFence({
    account_id: subjectAccountId,
    action: "set impersonation fresh auth",
    fn: async (db) => {
      await assertAccountWriteOnHomeBay({
        db,
        account_id: subjectAccountId,
        action: "set impersonation fresh auth",
      });
      await db.query(
        `
          UPDATE account_impersonation_sessions
             SET updated = NOW(),
                 actor_password_verified_at = NOW(),
                 actor_factor_verified_at =
                   CASE
                     WHEN $3::VARCHAR(32) = 'none' THEN actor_factor_verified_at
                     ELSE NOW()
                   END,
                 actor_fresh_auth_until = $2::TIMESTAMP,
                 actor_factor_level =
                   CASE
                     WHEN $3::VARCHAR(32) = 'none' THEN actor_factor_level
                     ELSE $3::VARCHAR(32)
                   END,
                 status = $4::VARCHAR(32)
           WHERE session_hash = $1::CHAR(127)
             AND subject_account_id = $5::UUID
        `,
        [
          sessionHash,
          fresh_auth_until,
          factor_level,
          IMPERSONATION_STATUS_ACTIVE,
          subjectAccountId,
        ],
      );
    },
  });
}

export async function endImpersonationSession({
  subject_account_id,
  session_hash,
  status = IMPERSONATION_STATUS_ENDED,
}: {
  subject_account_id: string;
  session_hash: string;
  status?: "ended" | "revoked";
}): Promise<void> {
  const subjectAccountId = ensureUuid("subject_account_id", subject_account_id);
  const sessionHash = `${session_hash ?? ""}`.trim();
  if (!sessionHash) {
    throw new Error("session_hash is required");
  }
  await withAccountRehomeWriteFence({
    account_id: subjectAccountId,
    action: "end impersonation session",
    fn: async (db) => {
      await db.query(
        `
          UPDATE account_impersonation_sessions
             SET updated = NOW(),
                 status = $2::VARCHAR(32)
           WHERE session_hash = $1::CHAR(127)
             AND subject_account_id = $3::UUID
        `,
        [sessionHash, status, subjectAccountId],
      );
    },
  });
}

export async function getImpersonationBootstrapInfo({
  req,
  account_id,
}: {
  req: Request;
  account_id: string;
}): Promise<ImpersonationBootstrapInfo | undefined> {
  const session = await getCurrentImpersonationSession({ req, account_id });
  if (!session) {
    return;
  }
  const actor = await getAccountSummary(session.actor_account_id);
  const actor_name =
    `${actor.first_name ?? ""} ${actor.last_name ?? ""}`.trim();
  return {
    active: true,
    actor_account_id: session.actor_account_id,
    actor_email_address: actor.email_address ?? null,
    actor_name: actor_name || actor.email_address || session.actor_account_id,
    subject_account_id: session.subject_account_id,
    fresh_auth_until: session.actor_fresh_auth_until ?? null,
    factor_level: session.actor_factor_level ?? "none",
  };
}

export async function assertNoImpersonationForSubjectSecurityAction({
  req,
  account_id,
  action,
}: {
  req: Request;
  account_id: string;
  action: string;
}): Promise<void> {
  const impersonation = await getCurrentImpersonationSession({
    req,
    account_id,
  });
  if (!impersonation) {
    return;
  }
  throw Object.assign(
    new Error(
      `cannot ${action} while impersonating this account; perform that action directly as the user or use a dedicated admin flow`,
    ),
    {
      code: "impersonation_blocked",
      actor_account_id: impersonation.actor_account_id,
      subject_account_id: impersonation.subject_account_id,
    },
  );
}
