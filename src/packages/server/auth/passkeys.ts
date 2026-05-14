/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Request } from "express";
import { v4 as uuid } from "uuid";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type RegistrationResponseJSON,
  type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";

import passwordHash from "@cocalc/backend/auth/password-hash";
import getPool from "@cocalc/database/pool";
import { withAccountRehomeWriteFence } from "@cocalc/server/accounts/rehome-fence";
import hasPassword from "@cocalc/server/auth/has-password";
import {
  FRESH_AUTH_DEFAULT_MS,
  getCurrentAuthSession,
  requireFreshAuth,
  resolveFreshAuthDurationMs,
  revokeOtherAuthSessions,
  setCurrentSessionFreshAuth,
  setSessionFreshAuth,
  type FreshAuthDuration,
} from "@cocalc/server/auth/auth-sessions";
import isPasswordCorrect from "@cocalc/server/auth/is-password-correct";
import {
  deleteOtherRememberMe,
  getRememberMeHash,
} from "@cocalc/server/auth/remember-me";
import { getWebAuthnRelyingPartyForRequest } from "@cocalc/server/auth/webauthn-origin";
import {
  generateRecoveryCodes,
  normalizeRecoveryCode,
} from "@cocalc/server/auth/totp";
import { isValidUUID } from "@cocalc/util/misc";

export const FACTOR_TYPE_PASSKEY = "passkey";

const FACTOR_STATUS_PENDING = "pending";
const FACTOR_STATUS_ACTIVE = "active";
const FACTOR_STATUS_DISABLED = "disabled";
const CHALLENGE_PURPOSE_PASSKEY_SETUP = "passkey_setup";
const CHALLENGE_PURPOSE_SIGN_IN = "sign_in";
const CHALLENGE_PURPOSE_FRESH_AUTH = "fresh_auth";
const CHALLENGE_TTL_MS = 10 * 60_000;
const CHALLENGE_MAX_ATTEMPTS = 8;
const RECOVERY_CODE_COUNT = 10;

type Queryable = {
  query: <T = any>(
    sql: string,
    params?: any[],
  ) => Promise<{ rows: T[]; rowCount?: number | null }>;
};

type FactorRow = {
  id: string;
  account_id: string;
  type: string;
  label?: string | null;
  status: string;
  created?: Date | null;
  activated_at?: Date | null;
  disabled_at?: Date | null;
  last_used_at?: Date | null;
  metadata?: Record<string, any> | null;
};

type ChallengeRow = {
  id: string;
  account_id: string;
  purpose: string;
  password_verified_at?: Date | null;
  target_session_hash?: string | null;
  expire: Date;
  attempt_count: number;
  max_attempts: number;
  completed_at?: Date | null;
  metadata?: Record<string, any> | null;
};

export type PasskeySummary = {
  id: string;
  label: string;
  credential_id: string;
  created?: Date | null;
  activated_at?: Date | null;
  last_used_at?: Date | null;
  transports?: AuthenticatorTransportFuture[];
  backed_up?: boolean;
  device_type?: string;
  aaguid?: string;
  rp_id?: string;
};

export type PasskeySetupStart = {
  challenge_id: string;
  options: PublicKeyCredentialCreationOptionsJSON;
};

export type PasskeyAuthenticationStart = {
  challenge_id: string;
  options: PublicKeyCredentialRequestOptionsJSON;
};

export type PasskeySignInResult = {
  account_id: string;
  factor_level: "passkey";
  password_verified_at: Date;
  factor_verified_at: Date;
  fresh_auth_until: Date;
};

export type PasskeyFreshAuthStart = {
  challenge_id: string;
  options: PublicKeyCredentialRequestOptionsJSON;
};

export type PasskeyFreshAuthResult = {
  fresh_auth_until: Date;
  factor_level: "passkey";
  target_session_hash: string;
};

function ensureAccountId(account_id: string): string {
  const value = `${account_id ?? ""}`.trim();
  if (!isValidUUID(value)) {
    throw new Error("invalid account_id");
  }
  return value;
}

function cleanLabel(value: unknown): string {
  const label = `${value ?? ""}`.trim();
  return label.slice(0, 128) || "Passkey";
}

function cleanFreshAuthDuration(value: unknown): FreshAuthDuration {
  return value === "extended" ? "extended" : "default";
}

async function verifyCurrentPassword({
  account_id,
  current_password,
}: {
  account_id: string;
  current_password: string;
}): Promise<void> {
  if (!(await hasPassword(account_id))) {
    return;
  }
  if (
    !(await isPasswordCorrect({
      account_id,
      password: current_password,
    }))
  ) {
    throw new Error("current password is incorrect");
  }
}

function toBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const buffer = Buffer.from(value, "base64url");
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
  return new Uint8Array(arrayBuffer);
}

function summarizePasskey(row: FactorRow): PasskeySummary {
  const metadata = row.metadata ?? {};
  return {
    id: row.id,
    label: `${row.label ?? ""}`.trim() || "Passkey",
    credential_id: `${metadata.credential_id ?? ""}`,
    created: row.created ?? null,
    activated_at: row.activated_at ?? null,
    last_used_at: row.last_used_at ?? null,
    transports: Array.isArray(metadata.transports)
      ? metadata.transports
      : undefined,
    backed_up:
      typeof metadata.backed_up === "boolean" ? metadata.backed_up : undefined,
    device_type:
      typeof metadata.device_type === "string"
        ? metadata.device_type
        : undefined,
    aaguid: typeof metadata.aaguid === "string" ? metadata.aaguid : undefined,
    rp_id: typeof metadata.rp_id === "string" ? metadata.rp_id : undefined,
  };
}

export async function listActivePasskeyRows(
  account_id: string,
): Promise<FactorRow[]> {
  return (
    await getPool().query<FactorRow>(
      `
        SELECT id, account_id, type, label, status, created, activated_at,
               disabled_at, last_used_at, metadata
          FROM account_second_factors
         WHERE account_id = $1::UUID
           AND type = $2::VARCHAR(32)
           AND status = $3::VARCHAR(32)
         ORDER BY last_used_at DESC NULLS LAST, activated_at DESC NULLS LAST,
                  created DESC
      `,
      [ensureAccountId(account_id), FACTOR_TYPE_PASSKEY, FACTOR_STATUS_ACTIVE],
    )
  ).rows;
}

export async function listPasskeys({
  account_id,
}: {
  account_id: string;
}): Promise<{ passkeys: PasskeySummary[] }> {
  return {
    passkeys: (await listActivePasskeyRows(account_id)).map(summarizePasskey),
  };
}

export async function hasActivePasskey(account_id: string): Promise<boolean> {
  return (await listActivePasskeyRows(account_id)).length > 0;
}

export async function startPasskeySetup({
  req,
  account_id,
  label,
}: {
  req: Request;
  account_id: string;
  label?: string;
}): Promise<PasskeySetupStart> {
  const accountId = ensureAccountId(account_id);
  await requireFreshAuth({ req, account_id: accountId });
  const rp = await getWebAuthnRelyingPartyForRequest(req);
  const existing = await listActivePasskeyRows(accountId);
  const account = (
    await getPool().query<{
      email_address?: string | null;
      first_name?: string | null;
      last_name?: string | null;
      name?: string | null;
    }>(
      `
        SELECT email_address, first_name, last_name, name
          FROM accounts
         WHERE account_id = $1::UUID
         LIMIT 1
      `,
      [accountId],
    )
  ).rows[0];
  const email = `${account?.email_address ?? ""}`.trim();
  const displayName =
    `${account?.first_name ?? ""} ${account?.last_name ?? ""}`.trim() ||
    `${account?.name ?? ""}`.trim() ||
    email ||
    accountId;
  const options = await generateRegistrationOptions({
    rpName: rp.rp_name,
    rpID: rp.rp_id,
    userID: Buffer.from(accountId),
    userName: email || accountId,
    userDisplayName: displayName,
    attestationType: "none",
    excludeCredentials: existing
      .map((row) => `${row.metadata?.credential_id ?? ""}`.trim())
      .filter(Boolean)
      .map((id) => ({
        id,
        transports: existing.find(
          (row) => `${row.metadata?.credential_id ?? ""}`.trim() === id,
        )?.metadata?.transports,
      })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });
  const challenge_id = uuid();
  await withAccountRehomeWriteFence({
    account_id: accountId,
    action: "start passkey setup",
    fn: async (db) => {
      await db.query(
        `
          INSERT INTO account_auth_challenges(
            id, account_id, purpose, password_verified_at, factor_verified_at,
            verified_factor_type, target_session_hash, expire, attempt_count,
            max_attempts, completed_at, created, metadata
          ) VALUES(
            $1::UUID, $2::UUID, $3::VARCHAR(32), NOW(), NULL, NULL, $4::CHAR(127),
            $5::TIMESTAMP, 0, $6::INTEGER, NULL, NOW(), $7::JSONB
          )
        `,
        [
          challenge_id,
          accountId,
          CHALLENGE_PURPOSE_PASSKEY_SETUP,
          getRememberMeHash(req) ?? null,
          new Date(Date.now() + CHALLENGE_TTL_MS),
          CHALLENGE_MAX_ATTEMPTS,
          JSON.stringify({
            challenge: options.challenge,
            origin: rp.origin,
            rp_id: rp.rp_id,
            rp_name: rp.rp_name,
            label: cleanLabel(label),
          }),
        ],
      );
    },
  });
  return { challenge_id, options };
}

async function issueRecoveryCodesWithDb({
  db,
  account_id,
  factor_id,
}: {
  db: Queryable;
  account_id: string;
  factor_id: string;
}): Promise<string[]> {
  const codes = generateRecoveryCodes(RECOVERY_CODE_COUNT);
  await db.query(
    "DELETE FROM account_second_factor_recovery_codes WHERE account_id = $1::UUID",
    [account_id],
  );
  for (const code of codes) {
    await db.query(
      `
        INSERT INTO account_second_factor_recovery_codes(
          id, account_id, factor_id, code_hash, used_at, created, metadata
        ) VALUES(
          $1::UUID, $2::UUID, $3::UUID, $4::VARCHAR(173), NULL, NOW(), $5::JSONB
        )
      `,
      [
        uuid(),
        account_id,
        factor_id,
        passwordHash(normalizeRecoveryCode(code)),
        "{}",
      ],
    );
  }
  return codes;
}

async function activeSecondFactorCountWithDb({
  db,
  account_id,
}: {
  db: Queryable;
  account_id: string;
}): Promise<number> {
  const row = (
    await db.query<{ count: string }>(
      `
        SELECT COUNT(*)::TEXT AS count
          FROM account_second_factors
         WHERE account_id = $1::UUID
           AND status = $2::VARCHAR(32)
           AND type IN ('totp', 'passkey')
      `,
      [account_id, FACTOR_STATUS_ACTIVE],
    )
  ).rows[0];
  return Number(row?.count ?? 0) || 0;
}

export async function finishPasskeySetup({
  req,
  account_id,
  challenge_id,
  response,
  label,
}: {
  req: Request;
  account_id: string;
  challenge_id: string;
  response: RegistrationResponseJSON;
  label?: string;
}): Promise<{ passkey: PasskeySummary; recovery_codes: string[] }> {
  const accountId = ensureAccountId(account_id);
  const challengeId = `${challenge_id ?? ""}`.trim();
  let passkey: PasskeySummary | undefined;
  let recovery_codes: string[] = [];
  await withAccountRehomeWriteFence({
    account_id: accountId,
    action: "finish passkey setup",
    fn: async (db) => {
      const q = db as Queryable;
      const challenge = (
        await q.query<ChallengeRow>(
          `
            SELECT *
              FROM account_auth_challenges
             WHERE id = $1::UUID
             FOR UPDATE
          `,
          [challengeId],
        )
      ).rows[0];
      if (
        !challenge ||
        challenge.account_id !== accountId ||
        challenge.purpose !== CHALLENGE_PURPOSE_PASSKEY_SETUP
      ) {
        throw new Error("passkey setup challenge not found");
      }
      if (challenge.completed_at) {
        throw new Error("passkey setup challenge has already been used");
      }
      if (new Date(challenge.expire).valueOf() < Date.now()) {
        throw new Error("passkey setup challenge has expired");
      }
      if ((challenge.attempt_count ?? 0) >= (challenge.max_attempts ?? 0)) {
        throw new Error("too many passkey setup attempts");
      }
      const metadata = challenge.metadata ?? {};
      const verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: `${metadata.challenge ?? ""}`,
        expectedOrigin: `${metadata.origin ?? ""}`,
        expectedRPID: `${metadata.rp_id ?? ""}`,
        requireUserVerification: false,
      });
      if (!verification.verified) {
        await q.query(
          `
            UPDATE account_auth_challenges
               SET attempt_count = attempt_count + 1
             WHERE id = $1::UUID
          `,
          [challengeId],
        );
        throw new Error("passkey setup verification failed");
      }
      const info = verification.registrationInfo;
      const credential_id = info.credential.id;
      const duplicate = (
        await q.query(
          `
            SELECT id
              FROM account_second_factors
             WHERE type = $1::VARCHAR(32)
               AND status IN ($2::VARCHAR(32), $3::VARCHAR(32))
               AND metadata->>'credential_id' = $4
             LIMIT 1
          `,
          [
            FACTOR_TYPE_PASSKEY,
            FACTOR_STATUS_ACTIVE,
            FACTOR_STATUS_PENDING,
            credential_id,
          ],
        )
      ).rows[0];
      if (duplicate) {
        throw new Error("passkey is already registered");
      }
      const factor_id = uuid();
      const row: FactorRow = {
        id: factor_id,
        account_id: accountId,
        type: FACTOR_TYPE_PASSKEY,
        label: cleanLabel(label ?? metadata.label),
        status: FACTOR_STATUS_ACTIVE,
        metadata: {
          credential_id,
          credential_public_key: toBase64Url(info.credential.publicKey),
          counter: info.credential.counter,
          transports: response.response.transports ?? [],
          backed_up: info.credentialBackedUp,
          device_type: info.credentialDeviceType,
          aaguid: info.aaguid,
          rp_id: info.rpID ?? metadata.rp_id,
          origin: info.origin,
          user_verified: info.userVerified,
        },
      };
      await db.query(
        `
          INSERT INTO account_second_factors(
            id, account_id, type, label, secret_encrypted, status, created,
            activated_at, disabled_at, last_used_at, metadata
          ) VALUES(
            $1::UUID, $2::UUID, $3::VARCHAR(32), $4::VARCHAR(128), $5::TEXT,
            $6::VARCHAR(32), NOW(), NOW(), NULL, NOW(), $7::JSONB
          )
        `,
        [
          row.id,
          row.account_id,
          row.type,
          row.label,
          "",
          row.status,
          JSON.stringify(row.metadata),
        ],
      );
      await db.query(
        `
          UPDATE account_auth_challenges
             SET attempt_count = attempt_count + 1,
                 factor_verified_at = NOW(),
                 verified_factor_type = $2::VARCHAR(32),
                 completed_at = NOW()
           WHERE id = $1::UUID
        `,
        [challengeId, FACTOR_TYPE_PASSKEY],
      );
      if (
        (await activeSecondFactorCountWithDb({ db, account_id: accountId })) ===
        1
      ) {
        recovery_codes = await issueRecoveryCodesWithDb({
          db,
          account_id: accountId,
          factor_id,
        });
      }
      passkey = summarizePasskey({
        ...row,
        created: new Date(),
        activated_at: new Date(),
        last_used_at: new Date(),
      });
    },
  });
  if (!passkey) {
    throw new Error("passkey setup failed");
  }
  const currentHash = getRememberMeHash(req);
  if (currentHash) {
    await deleteOtherRememberMe(accountId, currentHash);
    await revokeOtherAuthSessions({
      account_id: accountId,
      keep_session_hash: currentHash,
    });
    await setCurrentSessionFreshAuth({
      req,
      account_id: accountId,
      factor_level: FACTOR_TYPE_PASSKEY,
      fresh_auth_until: new Date(Date.now() + FRESH_AUTH_DEFAULT_MS),
    });
  }
  return { passkey, recovery_codes };
}

function toWebAuthnCredential(row: FactorRow) {
  const metadata = row.metadata ?? {};
  const credential_id = `${metadata.credential_id ?? ""}`.trim();
  const publicKey = `${metadata.credential_public_key ?? ""}`.trim();
  if (!credential_id || !publicKey) {
    throw new Error("passkey credential metadata is incomplete");
  }
  return {
    id: credential_id,
    publicKey: fromBase64Url(publicKey),
    counter: Number(metadata.counter ?? 0) || 0,
    transports: Array.isArray(metadata.transports)
      ? metadata.transports
      : undefined,
  };
}

async function getActivePasskeyByCredentialIdWithDb({
  db,
  account_id,
  credential_id,
}: {
  db: Queryable;
  account_id: string;
  credential_id: string;
}): Promise<FactorRow | null> {
  const row = (
    await db.query<FactorRow>(
      `
        SELECT *
          FROM account_second_factors
         WHERE account_id = $1::UUID
           AND type = $2::VARCHAR(32)
           AND status = $3::VARCHAR(32)
           AND metadata->>'credential_id' = $4
         LIMIT 1
         FOR UPDATE
      `,
      [account_id, FACTOR_TYPE_PASSKEY, FACTOR_STATUS_ACTIVE, credential_id],
    )
  ).rows[0];
  return row ?? null;
}

export async function startSignInPasskeyAuthentication({
  req,
  challenge_id,
}: {
  req: Request;
  challenge_id: string;
}): Promise<PasskeyAuthenticationStart> {
  const challengeId = `${challenge_id ?? ""}`.trim();
  const challenge = (
    await getPool().query<ChallengeRow>(
      `
        SELECT *
          FROM account_auth_challenges
         WHERE id = $1::UUID
         LIMIT 1
      `,
      [challengeId],
    )
  ).rows[0];
  if (!challenge || challenge.purpose !== CHALLENGE_PURPOSE_SIGN_IN) {
    throw new Error("sign-in challenge not found");
  }
  if (challenge.completed_at) {
    throw new Error("sign-in challenge has already been used");
  }
  if (new Date(challenge.expire).valueOf() < Date.now()) {
    throw new Error("sign-in challenge has expired");
  }
  const accountId = ensureAccountId(challenge.account_id);
  const passkeys = await listActivePasskeyRows(accountId);
  if (passkeys.length === 0) {
    throw new Error("no active passkeys");
  }
  const rp = await getWebAuthnRelyingPartyForRequest(req);
  const options = await generateAuthenticationOptions({
    rpID: rp.rp_id,
    allowCredentials: passkeys.map((row) => {
      const metadata = row.metadata ?? {};
      return {
        id: `${metadata.credential_id ?? ""}`,
        transports: Array.isArray(metadata.transports)
          ? metadata.transports
          : undefined,
      };
    }),
    userVerification: "preferred",
  });
  await withAccountRehomeWriteFence({
    account_id: accountId,
    action: "start sign-in passkey authentication",
    fn: async (db) => {
      await db.query(
        `
          UPDATE account_auth_challenges
             SET metadata = coalesce(metadata, '{}'::JSONB) || $2::JSONB
           WHERE id = $1::UUID
        `,
        [
          challengeId,
          JSON.stringify({
            passkey_challenge: options.challenge,
            passkey_origin: rp.origin,
            passkey_rp_id: rp.rp_id,
          }),
        ],
      );
    },
  });
  return { challenge_id: challengeId, options };
}

export async function finishSignInPasskeyAuthentication({
  challenge_id,
  response,
}: {
  challenge_id: string;
  response: AuthenticationResponseJSON;
}): Promise<PasskeySignInResult> {
  const challengeId = `${challenge_id ?? ""}`.trim();
  const initialChallenge = (
    await getPool().query<ChallengeRow>(
      `
        SELECT account_id, purpose
          FROM account_auth_challenges
         WHERE id = $1::UUID
         LIMIT 1
      `,
      [challengeId],
    )
  ).rows[0];
  if (
    !initialChallenge ||
    initialChallenge.purpose !== CHALLENGE_PURPOSE_SIGN_IN
  ) {
    throw new Error("sign-in challenge not found");
  }
  const initialAccountId = ensureAccountId(initialChallenge.account_id);
  let result: PasskeySignInResult | undefined;
  await withAccountRehomeWriteFence({
    account_id: initialAccountId,
    action: "finish sign-in passkey authentication",
    fn: async (db) => {
      const q = db as Queryable;
      const challenge = (
        await q.query<ChallengeRow>(
          `
            SELECT *
              FROM account_auth_challenges
             WHERE id = $1::UUID
             FOR UPDATE
          `,
          [challengeId],
        )
      ).rows[0];
      if (!challenge || challenge.purpose !== CHALLENGE_PURPOSE_SIGN_IN) {
        throw new Error("sign-in challenge not found");
      }
      const accountId = ensureAccountId(challenge.account_id);
      if (challenge.completed_at) {
        throw new Error("sign-in challenge has already been used");
      }
      if (new Date(challenge.expire).valueOf() < Date.now()) {
        throw new Error("sign-in challenge has expired");
      }
      if ((challenge.attempt_count ?? 0) >= (challenge.max_attempts ?? 0)) {
        throw new Error("too many second factor attempts");
      }
      const metadata = challenge.metadata ?? {};
      const credential_id = `${response?.id ?? ""}`.trim();
      const passkey = await getActivePasskeyByCredentialIdWithDb({
        db: q,
        account_id: accountId,
        credential_id,
      });
      if (!passkey) {
        await q.query(
          `
            UPDATE account_auth_challenges
               SET attempt_count = attempt_count + 1
             WHERE id = $1::UUID
          `,
          [challengeId],
        );
        throw new Error("passkey credential not found");
      }
      const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: `${metadata.passkey_challenge ?? ""}`,
        expectedOrigin: `${metadata.passkey_origin ?? ""}`,
        expectedRPID: `${metadata.passkey_rp_id ?? ""}`,
        credential: toWebAuthnCredential(passkey),
        requireUserVerification: false,
      });
      if (!verification.verified) {
        await q.query(
          `
            UPDATE account_auth_challenges
               SET attempt_count = attempt_count + 1
             WHERE id = $1::UUID
          `,
          [challengeId],
        );
        throw new Error("passkey verification failed");
      }
      const factor_verified_at = new Date();
      const password_verified_at = challenge.password_verified_at
        ? new Date(challenge.password_verified_at)
        : new Date();
      await q.query(
        `
          UPDATE account_second_factors
             SET last_used_at = NOW(),
                 metadata = coalesce(metadata, '{}'::JSONB) || $2::JSONB
           WHERE id = $1::UUID
        `,
        [
          passkey.id,
          JSON.stringify({
            counter: verification.authenticationInfo.newCounter,
            backed_up: verification.authenticationInfo.credentialBackedUp,
            device_type: verification.authenticationInfo.credentialDeviceType,
            origin: verification.authenticationInfo.origin,
            rp_id: verification.authenticationInfo.rpID,
            user_verified: verification.authenticationInfo.userVerified,
          }),
        ],
      );
      await q.query(
        `
          UPDATE account_auth_challenges
             SET attempt_count = attempt_count + 1,
                 factor_verified_at = NOW(),
                 verified_factor_type = $2::VARCHAR(32),
                 completed_at = NOW()
           WHERE id = $1::UUID
        `,
        [challengeId, FACTOR_TYPE_PASSKEY],
      );
      result = {
        account_id: accountId,
        factor_level: FACTOR_TYPE_PASSKEY,
        password_verified_at,
        factor_verified_at,
        fresh_auth_until: new Date(Date.now() + FRESH_AUTH_DEFAULT_MS),
      };
    },
  });
  if (!result) {
    throw new Error("passkey verification failed");
  }
  return result;
}

export async function startFreshAuthPasskeyAuthentication({
  req,
  account_id,
  current_password,
  duration,
  target_session_hash,
  metadata,
}: {
  req: Request;
  account_id: string;
  current_password: string;
  duration?: FreshAuthDuration;
  target_session_hash?: string;
  metadata?: Record<string, unknown>;
}): Promise<PasskeyFreshAuthStart> {
  const accountId = ensureAccountId(account_id);
  const session = await getCurrentAuthSession({ req, account_id: accountId });
  const sessionHash = getRememberMeHash(req);
  if (!sessionHash) {
    throw new Error("browser sign-in is required");
  }
  const targetSessionHash = `${target_session_hash ?? session.session_hash ?? sessionHash}`;
  await verifyCurrentPassword({
    account_id: accountId,
    current_password,
  });
  const passkeys = await listActivePasskeyRows(accountId);
  if (passkeys.length === 0) {
    throw new Error("no active passkeys");
  }
  const rp = await getWebAuthnRelyingPartyForRequest(req);
  const options = await generateAuthenticationOptions({
    rpID: rp.rp_id,
    allowCredentials: passkeys.map((row) => {
      const metadata = row.metadata ?? {};
      return {
        id: `${metadata.credential_id ?? ""}`,
        transports: Array.isArray(metadata.transports)
          ? metadata.transports
          : undefined,
      };
    }),
    userVerification: "preferred",
  });
  const challenge_id = uuid();
  await withAccountRehomeWriteFence({
    account_id: accountId,
    action: "start passkey fresh auth",
    fn: async (db) => {
      await db.query(
        `
          INSERT INTO account_auth_challenges(
            id, account_id, purpose, password_verified_at, factor_verified_at,
            verified_factor_type, target_session_hash, expire, attempt_count,
            max_attempts, completed_at, created, metadata
          ) VALUES(
            $1::UUID, $2::UUID, $3::VARCHAR(32), NOW(), NULL, NULL, $4::CHAR(127),
            $5::TIMESTAMP, 0, $6::INTEGER, NULL, NOW(), $7::JSONB
          )
        `,
        [
          challenge_id,
          accountId,
          CHALLENGE_PURPOSE_FRESH_AUTH,
          targetSessionHash,
          new Date(Date.now() + CHALLENGE_TTL_MS),
          CHALLENGE_MAX_ATTEMPTS,
          JSON.stringify({
            ...(metadata ?? {}),
            passkey_challenge: options.challenge,
            passkey_origin: rp.origin,
            passkey_rp_id: rp.rp_id,
            duration: cleanFreshAuthDuration(duration),
          }),
        ],
      );
    },
  });
  return { challenge_id, options };
}

export async function finishFreshAuthPasskeyAuthentication({
  req,
  account_id,
  challenge_id,
  response,
  allow_target_session_hash = false,
}: {
  req: Request;
  account_id: string;
  challenge_id: string;
  response: AuthenticationResponseJSON;
  allow_target_session_hash?: boolean;
}): Promise<PasskeyFreshAuthResult> {
  const accountId = ensureAccountId(account_id);
  const sessionHash = getRememberMeHash(req);
  if (!sessionHash) {
    throw new Error("browser sign-in is required");
  }
  const challengeId = `${challenge_id ?? ""}`.trim();
  let result: PasskeyFreshAuthResult | undefined;
  await withAccountRehomeWriteFence({
    account_id: accountId,
    action: "finish passkey fresh auth",
    fn: async (db) => {
      const q = db as Queryable;
      const challenge = (
        await q.query<ChallengeRow>(
          `
            SELECT *
              FROM account_auth_challenges
             WHERE id = $1::UUID
             FOR UPDATE
          `,
          [challengeId],
        )
      ).rows[0];
      if (
        !challenge ||
        challenge.account_id !== accountId ||
        challenge.purpose !== CHALLENGE_PURPOSE_FRESH_AUTH
      ) {
        throw new Error("fresh auth passkey challenge not found");
      }
      if (challenge.completed_at) {
        throw new Error("fresh auth passkey challenge has already been used");
      }
      if (new Date(challenge.expire).valueOf() < Date.now()) {
        throw new Error("fresh auth passkey challenge has expired");
      }
      if ((challenge.attempt_count ?? 0) >= (challenge.max_attempts ?? 0)) {
        throw new Error("too many passkey fresh auth attempts");
      }
      const targetSessionHash = `${challenge.target_session_hash ?? ""}`;
      if (
        targetSessionHash &&
        targetSessionHash !== sessionHash &&
        !allow_target_session_hash
      ) {
        throw new Error("fresh auth passkey challenge is for another session");
      }
      const metadata = challenge.metadata ?? {};
      const credential_id = `${response?.id ?? ""}`.trim();
      const passkey = await getActivePasskeyByCredentialIdWithDb({
        db: q,
        account_id: accountId,
        credential_id,
      });
      if (!passkey) {
        await q.query(
          `
            UPDATE account_auth_challenges
               SET attempt_count = attempt_count + 1
             WHERE id = $1::UUID
          `,
          [challengeId],
        );
        throw new Error("passkey credential not found");
      }
      const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: `${metadata.passkey_challenge ?? ""}`,
        expectedOrigin: `${metadata.passkey_origin ?? ""}`,
        expectedRPID: `${metadata.passkey_rp_id ?? ""}`,
        credential: toWebAuthnCredential(passkey),
        requireUserVerification: false,
      });
      if (!verification.verified) {
        await q.query(
          `
            UPDATE account_auth_challenges
               SET attempt_count = attempt_count + 1
             WHERE id = $1::UUID
          `,
          [challengeId],
        );
        throw new Error("passkey verification failed");
      }
      await q.query(
        `
          UPDATE account_second_factors
             SET last_used_at = NOW(),
                 metadata = coalesce(metadata, '{}'::JSONB) || $2::JSONB
           WHERE id = $1::UUID
        `,
        [
          passkey.id,
          JSON.stringify({
            counter: verification.authenticationInfo.newCounter,
            backed_up: verification.authenticationInfo.credentialBackedUp,
            device_type: verification.authenticationInfo.credentialDeviceType,
            origin: verification.authenticationInfo.origin,
            rp_id: verification.authenticationInfo.rpID,
            user_verified: verification.authenticationInfo.userVerified,
          }),
        ],
      );
      await q.query(
        `
          UPDATE account_auth_challenges
             SET attempt_count = attempt_count + 1,
                 factor_verified_at = NOW(),
                 verified_factor_type = $2::VARCHAR(32),
                 completed_at = NOW()
           WHERE id = $1::UUID
        `,
        [challengeId, FACTOR_TYPE_PASSKEY],
      );
      result = {
        factor_level: FACTOR_TYPE_PASSKEY,
        target_session_hash: targetSessionHash || sessionHash,
        fresh_auth_until: new Date(
          Date.now() +
            resolveFreshAuthDurationMs({
              duration: cleanFreshAuthDuration(metadata.duration),
              factor_level: FACTOR_TYPE_PASSKEY,
            }),
        ),
      };
    },
  });
  if (!result) {
    throw new Error("passkey fresh auth failed");
  }
  await setSessionFreshAuth({
    account_id: accountId,
    session_hash: result.target_session_hash,
    factor_level: result.factor_level,
    fresh_auth_until: result.fresh_auth_until,
  });
  return result;
}

export async function disablePasskey({
  req,
  account_id,
  factor_id,
}: {
  req: Request;
  account_id: string;
  factor_id: string;
}): Promise<void> {
  const accountId = ensureAccountId(account_id);
  await requireFreshAuth({ req, account_id: accountId });
  const factorId = `${factor_id ?? ""}`.trim();
  await withAccountRehomeWriteFence({
    account_id: accountId,
    action: "disable passkey",
    fn: async (db) => {
      const q = db as Queryable;
      const row = (
        await q.query<FactorRow>(
          `
            SELECT *
              FROM account_second_factors
             WHERE id = $1::UUID
               AND account_id = $2::UUID
               AND type = $3::VARCHAR(32)
               AND status = $4::VARCHAR(32)
             FOR UPDATE
          `,
          [factorId, accountId, FACTOR_TYPE_PASSKEY, FACTOR_STATUS_ACTIVE],
        )
      ).rows[0];
      if (!row) {
        throw new Error("active passkey not found");
      }
      const activeCount = await activeSecondFactorCountWithDb({
        db: q,
        account_id: accountId,
      });
      if (activeCount <= 1) {
        throw new Error("cannot disable the last active second factor");
      }
      await q.query(
        `
          UPDATE account_second_factors
             SET status = $3::VARCHAR(32),
                 disabled_at = NOW()
           WHERE id = $1::UUID
             AND account_id = $2::UUID
        `,
        [factorId, accountId, FACTOR_STATUS_DISABLED],
      );
    },
  });
}

export async function renamePasskey({
  req,
  account_id,
  factor_id,
  label,
}: {
  req: Request;
  account_id: string;
  factor_id: string;
  label: string;
}): Promise<{ passkey: PasskeySummary }> {
  const accountId = ensureAccountId(account_id);
  await requireFreshAuth({ req, account_id: accountId });
  const factorId = `${factor_id ?? ""}`.trim();
  const nextLabel = cleanLabel(label);
  let row: FactorRow | undefined;
  await withAccountRehomeWriteFence({
    account_id: accountId,
    action: "rename passkey",
    fn: async (db) => {
      const q = db as Queryable;
      const result = await q.query<FactorRow>(
        `
          UPDATE account_second_factors
             SET label = $3::VARCHAR(128)
           WHERE id = $1::UUID
             AND account_id = $2::UUID
             AND type = $4::VARCHAR(32)
             AND status = $5::VARCHAR(32)
       RETURNING id, account_id, type, label, status, created, activated_at,
                 disabled_at, last_used_at, metadata
        `,
        [
          factorId,
          accountId,
          nextLabel,
          FACTOR_TYPE_PASSKEY,
          FACTOR_STATUS_ACTIVE,
        ],
      );
      row = result.rows[0];
      if (!row) {
        throw new Error("active passkey not found");
      }
    },
  });
  if (!row) {
    throw new Error("active passkey not found");
  }
  return { passkey: summarizePasskey(row) };
}
