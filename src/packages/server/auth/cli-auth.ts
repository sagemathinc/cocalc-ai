/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import basePath from "@cocalc/backend/base-path";
import getPool from "@cocalc/database/pool";
import { withAccountRehomeWriteFence } from "@cocalc/server/accounts/rehome-fence";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getBayPublicOriginForRequest } from "@cocalc/server/bay-public-origin";
import {
  getCurrentAuthSessionForSessionHash,
  resolveFreshAuthDurationMs,
  setSessionFreshAuth,
  type AuthSessionFactorLevel,
  type FreshAuthDuration,
} from "@cocalc/server/auth/auth-sessions";
import { createRememberMeCookie } from "@cocalc/server/auth/remember-me";
import { recordNewAuthSession } from "@cocalc/server/auth/auth-sessions";
import { DEFAULT_MAX_AGE_MS } from "@cocalc/server/auth/set-sign-in-cookies";
import {
  issueHomeBayRetryToken,
  verifyHomeBayRetryToken,
} from "@cocalc/server/auth/home-bay-retry-token";
import { verifyFreshAuthCredentials } from "@cocalc/server/auth/two-factor";
import {
  finishFreshAuthPasskeyAuthentication,
  startFreshAuthPasskeyAuthentication,
  type PasskeyFreshAuthStart,
} from "@cocalc/server/auth/passkeys";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import {
  getClusterAccountByEmail,
  getClusterAccountById,
} from "@cocalc/server/inter-bay/accounts";
import { isValidUUID } from "@cocalc/util/misc";

const CHALLENGE_TTL_MS = 10 * 60_000;

export type CliAuthChallengeKind = "login" | "elevate";
export type CliAuthChallengeStatus =
  | "pending"
  | "approved"
  | "redeemed"
  | "canceled";

type Queryable = {
  query: <T = any>(
    sql: string,
    params?: any[],
  ) => Promise<{ rows: T[]; rowCount?: number | null }>;
};

type CliAuthChallengeRow = {
  id: string;
  account_id: string;
  kind: CliAuthChallengeKind;
  status: CliAuthChallengeStatus;
  poll_token_hash: string;
  redeem_token_hash?: string | null;
  target_session_hash?: string | null;
  requested_duration?: FreshAuthDuration | null;
  approved_at?: Date | null;
  redeemed_at?: Date | null;
  expire: Date;
  created: Date;
  metadata?: Record<string, any> | null;
};

function cleanEmail(email: string): string {
  return `${email ?? ""}`.trim().toLowerCase();
}

function cleanChallengeId(challenge_id: string): string {
  const value = `${challenge_id ?? ""}`.trim();
  if (!isValidUUID(value)) {
    throw new Error("invalid challenge id");
  }
  return value;
}

function cleanSessionHash(session_hash: string): string {
  const value = `${session_hash ?? ""}`.trim();
  if (!value) {
    throw new Error("session hash is required");
  }
  return value;
}

function hashToken(token: string): string {
  return createHash("sha256")
    .update(`${token ?? ""}`, "utf8")
    .digest("hex");
}

function createOpaqueToken(): string {
  return randomUUID();
}

function tokenMatches(raw: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(raw), "utf8");
  const expected = Buffer.from(`${expectedHash ?? ""}`, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isChallengeExpired(row: CliAuthChallengeRow): boolean {
  return new Date(row.expire).valueOf() <= Date.now();
}

async function getLocalAccountByEmail(email: string): Promise<{
  account_id: string;
  email_address: string;
  banned: boolean;
} | null> {
  const row = (
    await getPool().query<{
      account_id: string;
      email_address: string;
      banned: boolean;
    }>(
      `
        SELECT account_id, email_address, banned
          FROM accounts
         WHERE email_address = $1
         LIMIT 1
      `,
      [email],
    )
  ).rows[0];
  return row ?? null;
}

async function getAccountLabel(account_id: string): Promise<{
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

async function getChallengeRow(
  challenge_id: string,
): Promise<CliAuthChallengeRow | null> {
  const row = (
    await getPool().query<CliAuthChallengeRow>(
      `
        SELECT *
          FROM account_cli_auth_challenges
         WHERE id = $1::UUID
         LIMIT 1
      `,
      [challenge_id],
    )
  ).rows[0];
  return row ?? null;
}

async function insertChallengeWithDb({
  db,
  account_id,
  kind,
  poll_token,
  target_session_hash,
  requested_duration,
  metadata,
}: {
  db: Queryable;
  account_id: string;
  kind: CliAuthChallengeKind;
  poll_token: string;
  target_session_hash?: string | null;
  requested_duration?: FreshAuthDuration | null;
  metadata?: Record<string, unknown>;
}): Promise<{ id: string; expire: Date }> {
  const id = randomUUID();
  const expire = new Date(Date.now() + CHALLENGE_TTL_MS);
  await db.query(
    `
      INSERT INTO account_cli_auth_challenges(
        id,
        account_id,
        kind,
        status,
        poll_token_hash,
        redeem_token_hash,
        target_session_hash,
        requested_duration,
        approved_at,
        redeemed_at,
        expire,
        created,
        metadata
      ) VALUES(
        $1::UUID,
        $2::UUID,
        $3::VARCHAR(32),
        'pending'::VARCHAR(32),
        $4::CHAR(64),
        NULL,
        $5::CHAR(127),
        $6::VARCHAR(32),
        NULL,
        NULL,
        $7::TIMESTAMP,
        NOW(),
        $8::JSONB
      )
    `,
    [
      id,
      account_id,
      kind,
      hashToken(poll_token),
      target_session_hash ?? null,
      requested_duration ?? null,
      expire,
      JSON.stringify(metadata ?? {}),
    ],
  );
  return { id, expire };
}

async function updateChallengeApprovalWithDb({
  db,
  row,
  metadataPatch,
  redeem_token,
}: {
  db: Queryable;
  row: CliAuthChallengeRow;
  metadataPatch?: Record<string, unknown>;
  redeem_token?: string;
}): Promise<void> {
  const metadata = {
    ...(row.metadata ?? {}),
    ...(metadataPatch ?? {}),
  };
  const redeem_token_hash =
    redeem_token != null
      ? hashToken(redeem_token)
      : (row.redeem_token_hash ?? null);
  await db.query(
    `
      UPDATE account_cli_auth_challenges
         SET status = 'approved'::VARCHAR(32),
             approved_at = COALESCE(approved_at, NOW()),
             redeem_token_hash = $2::CHAR(64),
             metadata = $3::JSONB
       WHERE id = $1::UUID
    `,
    [row.id, redeem_token_hash, JSON.stringify(metadata)],
  );
}

function approvalPath(
  kind: CliAuthChallengeKind,
  challenge_id: string,
): string {
  const path =
    kind === "login"
      ? `/auth/cli-login/${challenge_id}`
      : `/auth/cli-elevate/${challenge_id}`;
  return basePath === "/" ? path : `${basePath}${path}`;
}

async function challengeApprovalUrl({
  req,
  kind,
  challenge_id,
}: {
  req: any;
  kind: CliAuthChallengeKind;
  challenge_id: string;
}): Promise<string> {
  const origin =
    (await getBayPublicOriginForRequest(req, getConfiguredBayId())) ??
    "http://localhost";
  return new URL(approvalPath(kind, challenge_id), origin).toString();
}

async function ensureActiveChallengeForPoll({
  challenge_id,
  poll_token,
}: {
  challenge_id: string;
  poll_token: string;
}): Promise<CliAuthChallengeRow> {
  const row = await getChallengeRow(cleanChallengeId(challenge_id));
  if (!row) {
    throw new Error("unknown cli auth challenge");
  }
  if (!tokenMatches(`${poll_token ?? ""}`, row.poll_token_hash)) {
    throw new Error("invalid cli auth poll token");
  }
  if (isChallengeExpired(row)) {
    throw new Error("cli auth challenge expired");
  }
  return row;
}

async function ensureChallengeOwnedByAccount({
  challenge_id,
  account_id,
  expected_kind,
}: {
  challenge_id: string;
  account_id: string;
  expected_kind: CliAuthChallengeKind;
}): Promise<CliAuthChallengeRow> {
  const row = await getChallengeRow(cleanChallengeId(challenge_id));
  if (!row || row.kind !== expected_kind) {
    throw new Error("unknown cli auth challenge");
  }
  if (isChallengeExpired(row)) {
    throw new Error("cli auth challenge expired");
  }
  if (`${row.account_id ?? ""}`.trim() !== `${account_id ?? ""}`.trim()) {
    throw new Error("cli auth challenge account mismatch");
  }
  return row;
}

export async function startCliLoginChallenge({
  req,
  email,
  retry_token,
}: {
  req: any;
  email: string;
  retry_token?: string;
}): Promise<
  | {
      wrong_bay: true;
      home_bay_id: string;
      home_bay_url?: string;
      retry_token: string;
    }
  | {
      challenge_id: string;
      poll_token: string;
      approval_url: string;
      expires_at: Date;
      home_bay_id: string;
      home_bay_url?: string;
    }
> {
  const normalizedEmail = cleanEmail(email);
  if (!normalizedEmail) {
    throw new Error("email is required");
  }

  const global = await getClusterAccountByEmail(normalizedEmail);
  if (retry_token) {
    verifyHomeBayRetryToken({
      token: retry_token,
      home_bay_id: getConfiguredBayId(),
      email: normalizedEmail,
      purpose: "cli-login",
    });
  } else if (
    global?.home_bay_id &&
    `${global.home_bay_id}`.trim() !== getConfiguredBayId()
  ) {
    const home_bay_id = `${global.home_bay_id}`.trim();
    const retry = issueHomeBayRetryToken({
      email: normalizedEmail,
      home_bay_id,
      purpose: "cli-login",
    });
    return {
      wrong_bay: true,
      home_bay_id,
      home_bay_url:
        (await getBayPublicOriginForRequest(req, home_bay_id)) ?? undefined,
      retry_token: retry.token,
    };
  }

  const local = await getLocalAccountByEmail(normalizedEmail);
  if (!local) {
    throw new Error("no account with that email address");
  }
  if (local.banned) {
    throw new Error("this account is not allowed to sign in");
  }

  const poll_token = createOpaqueToken();
  const inserted = await withAccountRehomeWriteFence({
    account_id: local.account_id,
    action: "create cli auth login challenge",
    fn: async (db) =>
      await insertChallengeWithDb({
        db,
        account_id: local.account_id,
        kind: "login",
        poll_token,
        metadata: {
          email_address: normalizedEmail,
          auth_client: "cli",
        },
      }),
  });

  return {
    challenge_id: inserted.id,
    poll_token,
    approval_url: await challengeApprovalUrl({
      req,
      kind: "login",
      challenge_id: inserted.id,
    }),
    expires_at: inserted.expire,
    home_bay_id: getConfiguredBayId(),
    home_bay_url:
      (await getBayPublicOriginForRequest(req, getConfiguredBayId())) ??
      undefined,
  };
}

export async function startCliElevateChallenge({
  req,
  account_id,
  session_hash,
  duration,
}: {
  req: any;
  account_id: string;
  session_hash: string;
  duration?: FreshAuthDuration;
}): Promise<{
  challenge_id: string;
  poll_token: string;
  approval_url: string;
  expires_at: Date;
  home_bay_id: string;
  home_bay_url?: string;
}> {
  const target_session_hash = cleanSessionHash(session_hash);
  await getCurrentAuthSessionForSessionHash({
    account_id,
    session_hash: target_session_hash,
  });
  const poll_token = createOpaqueToken();
  const inserted = await withAccountRehomeWriteFence({
    account_id,
    action: "create cli auth elevate challenge",
    fn: async (db) =>
      await insertChallengeWithDb({
        db,
        account_id,
        kind: "elevate",
        poll_token,
        target_session_hash,
        requested_duration: duration ?? "default",
        metadata: {
          auth_client: "cli",
        },
      }),
  });
  return {
    challenge_id: inserted.id,
    poll_token,
    approval_url: await challengeApprovalUrl({
      req,
      kind: "elevate",
      challenge_id: inserted.id,
    }),
    expires_at: inserted.expire,
    home_bay_id: getConfiguredBayId(),
    home_bay_url:
      (await getBayPublicOriginForRequest(req, getConfiguredBayId())) ??
      undefined,
  };
}

export async function getCliAuthChallengeStatus({
  challenge_id,
  poll_token,
}: {
  challenge_id: string;
  poll_token: string;
}): Promise<{
  challenge_id: string;
  kind: CliAuthChallengeKind;
  state: "pending" | "approved" | "redeemed";
  expires_at: Date;
  redeem_token?: string;
  fresh_auth_until?: Date | null;
  factor_level?: AuthSessionFactorLevel | null;
}> {
  const row = await ensureActiveChallengeForPoll({ challenge_id, poll_token });
  const metadata = row.metadata ?? {};
  return {
    challenge_id: row.id,
    kind: row.kind,
    state: row.status === "canceled" ? "pending" : row.status,
    expires_at: new Date(row.expire),
    ...(row.kind === "login" && metadata.redeem_token
      ? { redeem_token: `${metadata.redeem_token}` }
      : {}),
    ...(row.kind === "elevate"
      ? {
          fresh_auth_until: metadata.fresh_auth_until
            ? new Date(metadata.fresh_auth_until)
            : null,
          factor_level:
            (metadata.factor_level as AuthSessionFactorLevel) ?? null,
        }
      : {}),
  };
}

export async function redeemCliLoginChallenge({
  challenge_id,
  redeem_token,
  user_agent,
  ip_address,
}: {
  challenge_id: string;
  redeem_token: string;
  user_agent?: string | null;
  ip_address?: string | null;
}): Promise<{
  account_id: string;
  remember_me: string;
  expire: Date;
  home_bay_id: string;
  home_bay_url?: string;
  email_address?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}> {
  const row = await getChallengeRow(cleanChallengeId(challenge_id));
  if (!row || row.kind !== "login") {
    throw new Error("unknown cli auth challenge");
  }
  if (row.status !== "approved") {
    throw new Error("cli auth challenge has not been approved");
  }
  if (isChallengeExpired(row)) {
    throw new Error("cli auth challenge expired");
  }
  const expectedHash = `${row.redeem_token_hash ?? ""}`.trim();
  if (!expectedHash || !tokenMatches(`${redeem_token ?? ""}`, expectedHash)) {
    throw new Error("invalid cli auth redeem token");
  }
  const { value, hash, expire } = await createRememberMeCookie(
    row.account_id,
    DEFAULT_MAX_AGE_MS / 1000,
  );
  await recordNewAuthSession({
    account_id: row.account_id,
    session_hash: hash,
    expire,
    authenticated_at: new Date(),
    password_verified_at: null,
    factor_verified_at: null,
    factor_level: "none",
    fresh_auth_until: null,
    metadata: {
      auth_client: "cli",
      approved_challenge_id: row.id,
      ip_address: ip_address ?? undefined,
      user_agent: user_agent ?? undefined,
    },
  });
  await withAccountRehomeWriteFence({
    account_id: row.account_id,
    action: "redeem cli auth login challenge",
    fn: async (db) => {
      await db.query(
        `
          UPDATE account_cli_auth_challenges
             SET status = 'redeemed'::VARCHAR(32),
                 redeemed_at = NOW(),
                 metadata = $2::JSONB
           WHERE id = $1::UUID
        `,
        [
          row.id,
          JSON.stringify({
            ...(row.metadata ?? {}),
            redeemed_session_hash: hash,
          }),
        ],
      );
    },
  });
  const account = await getClusterAccountById(row.account_id);
  const home_bay_id =
    `${account?.home_bay_id ?? ""}`.trim() || getConfiguredBayId();
  return {
    account_id: row.account_id,
    remember_me: value,
    expire,
    home_bay_id,
    home_bay_url: undefined,
    email_address: account?.email_address ?? null,
    first_name: account?.first_name ?? null,
    last_name: account?.last_name ?? null,
  };
}

export async function getCliAuthSessionStatus({
  account_id,
  session_hash,
}: {
  account_id: string;
  session_hash: string;
}): Promise<{
  account_id: string;
  authenticated_at?: Date;
  expire?: Date;
  factor_level: AuthSessionFactorLevel;
  fresh_auth_until?: Date | null;
  auth_client: string;
}> {
  const session = await getCurrentAuthSessionForSessionHash({
    account_id,
    session_hash,
  });
  return {
    account_id,
    authenticated_at: session.authenticated_at,
    expire: session.expire,
    factor_level: session.factor_level ?? "none",
    fresh_auth_until: session.fresh_auth_until ?? null,
    auth_client: `${session.metadata?.auth_client ?? "browser"}`,
  };
}

export async function getCliAuthApprovalInfo({
  challenge_id,
}: {
  challenge_id: string;
}): Promise<{
  challenge_id: string;
  kind: CliAuthChallengeKind;
  account_id: string;
  email_address?: string | null;
  display_name?: string | null;
  requested_duration?: FreshAuthDuration | null;
  state: CliAuthChallengeStatus;
  expires_at: Date;
}> {
  const row = await getChallengeRow(cleanChallengeId(challenge_id));
  if (!row) {
    throw new Error("unknown cli auth challenge");
  }
  const label = await getAccountLabel(row.account_id);
  const display_name =
    `${label.first_name ?? ""} ${label.last_name ?? ""}`.trim();
  return {
    challenge_id: row.id,
    kind: row.kind,
    account_id: row.account_id,
    email_address: label.email_address ?? null,
    display_name: display_name || null,
    requested_duration: row.requested_duration ?? null,
    state: row.status,
    expires_at: new Date(row.expire),
  };
}

export async function approveCliLoginChallenge({
  challenge_id,
  account_id,
}: {
  challenge_id: string;
  account_id: string;
}): Promise<{ approved: true }> {
  const row = await ensureChallengeOwnedByAccount({
    challenge_id,
    account_id,
    expected_kind: "login",
  });
  if (row.status === "redeemed") {
    throw new Error("cli auth challenge has already been redeemed");
  }
  await withAccountRehomeWriteFence({
    account_id,
    action: "approve cli auth login challenge",
    fn: async (db) => {
      const existingRedeemToken =
        typeof row.metadata?.redeem_token === "string"
          ? `${row.metadata.redeem_token}`
          : undefined;
      const redeem_token = existingRedeemToken ?? createOpaqueToken();
      const metadata = {
        ...(row.metadata ?? {}),
        redeem_token,
      };
      await updateChallengeApprovalWithDb({
        db,
        row,
        metadataPatch: metadata,
        redeem_token,
      });
    },
  });
  return { approved: true };
}

export async function approveCliElevateChallenge({
  challenge_id,
  account_id,
  current_password,
  method,
  code,
}: {
  challenge_id: string;
  account_id: string;
  current_password: string;
  method?: string;
  code?: string;
}): Promise<{
  approved: true;
  factor_level: AuthSessionFactorLevel;
  fresh_auth_until: Date;
}> {
  const row = await ensureChallengeOwnedByAccount({
    challenge_id,
    account_id,
    expected_kind: "elevate",
  });
  const target_session_hash = cleanSessionHash(
    `${row.target_session_hash ?? ""}`,
  );
  const factor_level = await verifyFreshAuthCredentials({
    account_id,
    current_password,
    method,
    code,
  });
  const fresh_auth_until = new Date(
    Date.now() +
      resolveFreshAuthDurationMs({
        duration: row.requested_duration ?? "default",
        factor_level,
      }),
  );
  await setSessionFreshAuth({
    account_id,
    session_hash: target_session_hash,
    factor_level,
    fresh_auth_until,
  });
  await withAccountRehomeWriteFence({
    account_id,
    action: "approve cli auth elevate challenge",
    fn: async (db) => {
      await updateChallengeApprovalWithDb({
        db,
        row,
        metadataPatch: {
          factor_level,
          fresh_auth_until: fresh_auth_until.toISOString(),
        },
      });
    },
  });
  return {
    approved: true,
    factor_level,
    fresh_auth_until,
  };
}

export async function startCliElevatePasskeyChallenge({
  req,
  challenge_id,
  account_id,
  current_password,
}: {
  req: any;
  challenge_id: string;
  account_id: string;
  current_password: string;
}): Promise<PasskeyFreshAuthStart> {
  const row = await ensureChallengeOwnedByAccount({
    challenge_id,
    account_id,
    expected_kind: "elevate",
  });
  if (row.status !== "pending") {
    throw new Error("cli auth challenge is not pending");
  }
  const target_session_hash = cleanSessionHash(
    `${row.target_session_hash ?? ""}`,
  );
  return await startFreshAuthPasskeyAuthentication({
    req,
    account_id,
    current_password,
    duration: row.requested_duration ?? "default",
    target_session_hash,
    metadata: {
      cli_auth_challenge_id: row.id,
    },
  });
}

export async function finishCliElevatePasskeyChallenge({
  req,
  challenge_id,
  passkey_challenge_id,
  account_id,
  response,
}: {
  req: any;
  challenge_id: string;
  passkey_challenge_id: string;
  account_id: string;
  response: AuthenticationResponseJSON;
}): Promise<{
  approved: true;
  factor_level: AuthSessionFactorLevel;
  fresh_auth_until: Date;
}> {
  const row = await ensureChallengeOwnedByAccount({
    challenge_id,
    account_id,
    expected_kind: "elevate",
  });
  if (row.status !== "pending") {
    throw new Error("cli auth challenge is not pending");
  }
  const target_session_hash = cleanSessionHash(
    `${row.target_session_hash ?? ""}`,
  );
  const result = await finishFreshAuthPasskeyAuthentication({
    req,
    account_id,
    challenge_id: passkey_challenge_id,
    response,
    allow_target_session_hash: true,
  });
  if (result.target_session_hash !== target_session_hash) {
    throw new Error("passkey challenge target session mismatch");
  }
  await withAccountRehomeWriteFence({
    account_id,
    action: "approve cli auth elevate passkey challenge",
    fn: async (db) => {
      await updateChallengeApprovalWithDb({
        db,
        row,
        metadataPatch: {
          factor_level: result.factor_level,
          fresh_auth_until: result.fresh_auth_until.toISOString(),
          passkey_challenge_id,
        },
      });
    },
  });
  return {
    approved: true,
    factor_level: result.factor_level,
    fresh_auth_until: result.fresh_auth_until,
  };
}
