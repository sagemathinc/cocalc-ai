/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { v4 as uuid } from "uuid";

import passwordHash, {
  verifyPassword,
} from "@cocalc/backend/auth/password-hash";
import getCustomize from "@cocalc/database/settings/customize";
import { getSecretSettingsKey } from "@cocalc/database/settings/secret-settings";
import getPool from "@cocalc/database/pool";
import { withAccountRehomeWriteFence } from "@cocalc/server/accounts/rehome-fence";
import hasPassword from "@cocalc/server/auth/has-password";
import isPasswordCorrect from "@cocalc/server/auth/is-password-correct";
import {
  getCurrentAuthSession,
  requireFreshAuth,
  resolveFreshAuthDurationMs,
  revokeOtherAuthSessions,
  setCurrentSessionFreshAuth,
  type AuthSessionFactorLevel,
  type FreshAuthDuration,
  type SecondFactorMethod,
} from "@cocalc/server/auth/auth-sessions";
import {
  buildTotpOtpauthUrl,
  generateRecoveryCodes,
  generateTotpSecret,
  normalizeRecoveryCode,
  verifyTotpCode,
} from "@cocalc/server/auth/totp";
import {
  deleteOtherRememberMe,
  getRememberMeHash,
} from "@cocalc/server/auth/remember-me";
import { decryptSecretSettingValue } from "@cocalc/util/secret-settings-crypto";
import { encryptSecretSettingValue } from "@cocalc/util/secret-settings-crypto";
import { isValidUUID } from "@cocalc/util/misc";

const FACTOR_TYPE_TOTP = "totp";
const FACTOR_STATUS_PENDING = "pending";
const FACTOR_STATUS_ACTIVE = "active";
const FACTOR_STATUS_DISABLED = "disabled";
const CHALLENGE_PURPOSE_SIGN_IN = "sign_in";
const CHALLENGE_TTL_MS = 10 * 60_000;
const CHALLENGE_MAX_ATTEMPTS = 8;
const RECOVERY_CODE_COUNT = 10;
const FACTOR_SECRET_AAD = "account_second_factor_secret";
const DEFAULT_FACTOR_LABEL = "Authenticator app";

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
  secret_encrypted: string;
  status: string;
  activated_at?: Date | null;
  disabled_at?: Date | null;
  last_used_at?: Date | null;
  metadata?: Record<string, unknown> | null;
};

type ChallengeRow = {
  id: string;
  account_id: string;
  purpose: string;
  password_verified_at?: Date | null;
  factor_verified_at?: Date | null;
  verified_factor_type?: string | null;
  expire: Date;
  attempt_count: number;
  max_attempts: number;
  completed_at?: Date | null;
};

function ensureAccountId(account_id: string): string {
  const value = `${account_id ?? ""}`.trim();
  if (!isValidUUID(value)) {
    throw new Error("invalid account_id");
  }
  return value;
}

async function getEncryptionKey(): Promise<Buffer> {
  return await getSecretSettingsKey();
}

function factorSecretName(factor_id: string): string {
  return `${FACTOR_SECRET_AAD}:${factor_id}`;
}

async function encryptFactorSecret(
  factor_id: string,
  secret: string,
): Promise<string> {
  return encryptSecretSettingValue(
    factorSecretName(factor_id),
    secret,
    await getEncryptionKey(),
  );
}

async function decryptFactorSecret(
  factor_id: string,
  encrypted: string,
): Promise<string> {
  return decryptSecretSettingValue(
    factorSecretName(factor_id),
    encrypted,
    await getEncryptionKey(),
  );
}

async function getActiveFactor(account_id: string): Promise<FactorRow | null> {
  const row = (
    await getPool().query<FactorRow>(
      `
        SELECT *
          FROM account_second_factors
         WHERE account_id = $1::UUID
           AND type = $2::VARCHAR(32)
           AND status = $3::VARCHAR(32)
         ORDER BY activated_at DESC NULLS LAST, created DESC
         LIMIT 1
      `,
      [account_id, FACTOR_TYPE_TOTP, FACTOR_STATUS_ACTIVE],
    )
  ).rows[0];
  return row ?? null;
}

async function getTotpAccountLabel(account_id: string): Promise<string> {
  const row = (
    await getPool().query<{ email_address?: string | null }>(
      `
        SELECT email_address
          FROM accounts
         WHERE account_id = $1::UUID
         LIMIT 1
      `,
      [account_id],
    )
  ).rows[0];
  const email = `${row?.email_address ?? ""}`.trim();
  return email || account_id;
}

async function getPendingFactorById(
  account_id: string,
  factor_id: string,
): Promise<FactorRow | null> {
  const row = (
    await getPool().query<FactorRow>(
      `
        SELECT *
          FROM account_second_factors
         WHERE account_id = $1::UUID
           AND id = $2::UUID
           AND type = $3::VARCHAR(32)
           AND status = $4::VARCHAR(32)
         LIMIT 1
      `,
      [account_id, factor_id, FACTOR_TYPE_TOTP, FACTOR_STATUS_PENDING],
    )
  ).rows[0];
  return row ?? null;
}

async function getChallenge(
  challenge_id: string,
): Promise<ChallengeRow | null> {
  const row = (
    await getPool().query<ChallengeRow>(
      `
        SELECT *
          FROM account_auth_challenges
         WHERE id = $1::UUID
         LIMIT 1
      `,
      [challenge_id],
    )
  ).rows[0];
  return row ?? null;
}

async function verifyTotpFactorCode(
  factor: FactorRow,
  code: string,
): Promise<boolean> {
  const secret = await decryptFactorSecret(factor.id, factor.secret_encrypted);
  return verifyTotpCode({ secret, code });
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

async function consumeRecoveryCodeWithDb({
  db,
  account_id,
  factor_id,
  code,
}: {
  db: Queryable;
  account_id: string;
  factor_id: string;
  code: string;
}): Promise<boolean> {
  const normalized = normalizeRecoveryCode(code);
  if (!normalized) {
    return false;
  }
  const rows = (
    await db.query<{
      id: string;
      code_hash: string;
    }>(
      `
        SELECT id, code_hash
          FROM account_second_factor_recovery_codes
         WHERE account_id = $1::UUID
           AND factor_id = $2::UUID
           AND used_at IS NULL
         ORDER BY created ASC
      `,
      [account_id, factor_id],
    )
  ).rows;
  for (const row of rows) {
    if (!verifyPassword(normalized, row.code_hash)) {
      continue;
    }
    const update = await db.query(
      `
        UPDATE account_second_factor_recovery_codes
           SET used_at = NOW()
         WHERE id = $1::UUID
           AND used_at IS NULL
      `,
      [row.id],
    );
    if ((update.rowCount ?? 0) > 0) {
      return true;
    }
  }
  return false;
}

async function markFactorUsedWithDb({
  db,
  factor_id,
}: {
  db: Queryable;
  factor_id: string;
}): Promise<void> {
  await db.query(
    `
      UPDATE account_second_factors
         SET last_used_at = NOW()
       WHERE id = $1::UUID
    `,
    [factor_id],
  );
}

function ensureFreshAuthCodeMethod(value: string): SecondFactorMethod {
  if (value === "totp" || value === "recovery_code") {
    return value;
  }
  throw new Error("invalid second factor method");
}

async function verifyFreshAuthInputs({
  account_id,
  current_password,
  method,
  code,
  db,
}: {
  account_id: string;
  current_password: string;
  method?: string;
  code?: string;
  db: Queryable;
}): Promise<AuthSessionFactorLevel> {
  if (await hasPassword(account_id)) {
    const ok = await isPasswordCorrect({
      account_id,
      password: current_password,
    });
    if (!ok) {
      throw new Error("current password is incorrect");
    }
  }

  const factor = (
    await db.query<FactorRow>(
      `
        SELECT *
          FROM account_second_factors
         WHERE account_id = $1::UUID
           AND type = $2::VARCHAR(32)
           AND status = $3::VARCHAR(32)
         ORDER BY activated_at DESC NULLS LAST, created DESC
         LIMIT 1
      `,
      [account_id, FACTOR_TYPE_TOTP, FACTOR_STATUS_ACTIVE],
    )
  ).rows[0];

  if (!factor) {
    return "none";
  }

  const resolvedMethod = ensureFreshAuthCodeMethod(`${method ?? ""}`);
  const resolvedCode = `${code ?? ""}`.trim();
  if (!resolvedCode) {
    throw new Error("second factor code is required");
  }
  if (resolvedMethod === "totp") {
    const secret = await decryptFactorSecret(
      factor.id,
      factor.secret_encrypted,
    );
    if (!verifyTotpCode({ secret, code: resolvedCode })) {
      throw new Error("invalid second factor code");
    }
  } else {
    const used = await consumeRecoveryCodeWithDb({
      db,
      account_id,
      factor_id: factor.id,
      code: resolvedCode,
    });
    if (!used) {
      throw new Error("invalid recovery code");
    }
  }
  await markFactorUsedWithDb({ db, factor_id: factor.id });
  return resolvedMethod;
}

export async function hasActiveSecondFactor(
  account_id: string,
): Promise<boolean> {
  return !!(await getActiveFactor(ensureAccountId(account_id)));
}

export async function getTwoFactorStatus({
  req,
  account_id,
}: {
  req: any;
  account_id: string;
}) {
  const accountId = ensureAccountId(account_id);
  const [activeFactor, pendingCount] = await Promise.all([
    getActiveFactor(accountId),
    getPool().query<{ count: string }>(
      `
        SELECT COUNT(*)::TEXT AS count
          FROM account_second_factors
         WHERE account_id = $1::UUID
           AND type = $2::VARCHAR(32)
           AND status = $3::VARCHAR(32)
      `,
      [accountId, FACTOR_TYPE_TOTP, FACTOR_STATUS_PENDING],
    ),
  ]);
  let fresh_auth_until: Date | null = null;
  try {
    fresh_auth_until =
      (await getCurrentAuthSession({ req, account_id: accountId }))
        .fresh_auth_until ?? null;
  } catch {}
  return {
    enabled: !!activeFactor,
    factor_type: activeFactor?.type ?? null,
    label: activeFactor?.label ?? null,
    last_used_at: activeFactor?.last_used_at ?? null,
    pending_setup_count: Number(pendingCount.rows[0]?.count ?? 0) || 0,
    fresh_auth_until,
  };
}

export async function startTwoFactorSetup({
  account_id,
}: {
  account_id: string;
}): Promise<{
  factor_id: string;
  secret: string;
  issuer: string;
  account_label: string;
  otpauth_url: string;
}> {
  const accountId = ensureAccountId(account_id);
  if (await hasActiveSecondFactor(accountId)) {
    throw new Error("two-factor authentication is already enabled");
  }
  const factor_id = uuid();
  const secret = generateTotpSecret();
  const encrypted = await encryptFactorSecret(factor_id, secret);
  const customize = await getCustomize(["siteName"]);
  const issuer = `${customize.siteName ?? "CoCalc"}`.trim() || "CoCalc";
  const account_label = await getTotpAccountLabel(accountId);

  await withAccountRehomeWriteFence({
    account_id: accountId,
    action: "start two-factor setup",
    fn: async (db) => {
      await db.query(
        `
          UPDATE account_second_factors
             SET status = $2::VARCHAR(32),
                 disabled_at = NOW()
           WHERE account_id = $1::UUID
             AND status = $3::VARCHAR(32)
        `,
        [accountId, FACTOR_STATUS_DISABLED, FACTOR_STATUS_PENDING],
      );
      await db.query(
        `
          INSERT INTO account_second_factors(
            id,
            account_id,
            type,
            label,
            secret_encrypted,
            status,
            created,
            activated_at,
            disabled_at,
            last_used_at,
            metadata
          ) VALUES(
            $1::UUID,
            $2::UUID,
            $3::VARCHAR(32),
            $4::VARCHAR(128),
            $5::TEXT,
            $6::VARCHAR(32),
            NOW(),
            NULL,
            NULL,
            NULL,
            $7::JSONB
          )
        `,
        [
          factor_id,
          accountId,
          FACTOR_TYPE_TOTP,
          DEFAULT_FACTOR_LABEL,
          encrypted,
          FACTOR_STATUS_PENDING,
          JSON.stringify({ issuer }),
        ],
      );
    },
  });

  return {
    factor_id,
    secret,
    issuer,
    account_label,
    otpauth_url: buildTotpOtpauthUrl({
      issuer,
      accountLabel: account_label,
      secret,
    }),
  };
}

export async function confirmTwoFactorSetup({
  req,
  account_id,
  factor_id,
  code,
}: {
  req: any;
  account_id: string;
  factor_id: string;
  code: string;
}): Promise<{ recovery_codes: string[] }> {
  const accountId = ensureAccountId(account_id);
  const pending = await getPendingFactorById(accountId, `${factor_id ?? ""}`);
  if (!pending) {
    throw new Error("pending two-factor setup not found");
  }
  if (!(await verifyTotpFactorCode(pending, code))) {
    throw new Error("invalid authenticator code");
  }
  const currentHash = getRememberMeHash(req);
  let recovery_codes: string[] = [];
  await withAccountRehomeWriteFence({
    account_id: accountId,
    action: "confirm two-factor setup",
    fn: async (db) => {
      await db.query(
        `
          UPDATE account_second_factors
             SET status = $2::VARCHAR(32),
                 disabled_at = NOW()
           WHERE account_id = $1::UUID
             AND type = $3::VARCHAR(32)
             AND status = $4::VARCHAR(32)
             AND id <> $5::UUID
        `,
        [
          accountId,
          FACTOR_STATUS_DISABLED,
          FACTOR_TYPE_TOTP,
          FACTOR_STATUS_ACTIVE,
          pending.id,
        ],
      );
      await db.query(
        `
          UPDATE account_second_factors
             SET status = $2::VARCHAR(32),
                 activated_at = NOW(),
                 disabled_at = NULL,
                 last_used_at = NOW()
           WHERE id = $1::UUID
        `,
        [pending.id, FACTOR_STATUS_ACTIVE],
      );
      recovery_codes = await issueRecoveryCodesWithDb({
        db,
        account_id: accountId,
        factor_id: pending.id,
      });
    },
  });
  if (currentHash) {
    await deleteOtherRememberMe(accountId, currentHash);
    await revokeOtherAuthSessions({
      account_id: accountId,
      keep_session_hash: currentHash,
    });
    await setCurrentSessionFreshAuth({
      req,
      account_id: accountId,
      factor_level: "totp",
      fresh_auth_until: new Date(Date.now() + 15 * 60_000),
    });
  }
  return { recovery_codes };
}

export async function createSignInSecondFactorChallenge({
  account_id,
}: {
  account_id: string;
}): Promise<{
  challenge_id: string;
  methods: SecondFactorMethod[];
}> {
  const accountId = ensureAccountId(account_id);
  if (!(await hasActiveSecondFactor(accountId))) {
    throw new Error("two-factor authentication is not enabled");
  }
  const challenge_id = uuid();
  await withAccountRehomeWriteFence({
    account_id: accountId,
    action: "create sign-in second-factor challenge",
    fn: async (db) => {
      await db.query(
        `
          INSERT INTO account_auth_challenges(
            id,
            account_id,
            purpose,
            password_verified_at,
            factor_verified_at,
            verified_factor_type,
            target_session_hash,
            expire,
            attempt_count,
            max_attempts,
            completed_at,
            created,
            metadata
          ) VALUES(
            $1::UUID,
            $2::UUID,
            $3::VARCHAR(32),
            NOW(),
            NULL,
            NULL,
            NULL,
            $4::TIMESTAMP,
            0,
            $5::INTEGER,
            NULL,
            NOW(),
            $6::JSONB
          )
        `,
        [
          challenge_id,
          accountId,
          CHALLENGE_PURPOSE_SIGN_IN,
          new Date(Date.now() + CHALLENGE_TTL_MS),
          CHALLENGE_MAX_ATTEMPTS,
          "{}",
        ],
      );
    },
  });
  return {
    challenge_id,
    methods: ["totp", "recovery_code"],
  };
}

export async function verifySignInSecondFactorChallenge({
  challenge_id,
  method,
  code,
}: {
  challenge_id: string;
  method: string;
  code: string;
}): Promise<{
  account_id: string;
  factor_level: AuthSessionFactorLevel;
  password_verified_at: Date;
  factor_verified_at: Date;
  fresh_auth_until: Date;
}> {
  const challenge = await getChallenge(`${challenge_id ?? ""}`);
  if (!challenge || challenge.purpose !== CHALLENGE_PURPOSE_SIGN_IN) {
    throw new Error("sign-in challenge not found");
  }
  const accountId = ensureAccountId(challenge.account_id);
  const resolvedMethod = ensureFreshAuthCodeMethod(`${method ?? ""}`);
  const resolvedCode = `${code ?? ""}`.trim();
  if (!resolvedCode) {
    throw new Error("second factor code is required");
  }

  let password_verified_at = new Date();
  let factor_verified_at = new Date();
  await withAccountRehomeWriteFence({
    account_id: accountId,
    action: "complete sign-in second-factor challenge",
    fn: async (db) => {
      const locked = (
        await db.query(
          `
            SELECT *
              FROM account_auth_challenges
             WHERE id = $1::UUID
             FOR UPDATE
          `,
          [challenge_id],
        )
      ).rows[0] as ChallengeRow | undefined;
      if (!locked || locked.purpose !== CHALLENGE_PURPOSE_SIGN_IN) {
        throw new Error("sign-in challenge not found");
      }
      if (locked.completed_at) {
        throw new Error("sign-in challenge has already been used");
      }
      if (new Date(locked.expire).valueOf() < Date.now()) {
        throw new Error("sign-in challenge has expired");
      }
      if ((locked.attempt_count ?? 0) >= (locked.max_attempts ?? 0)) {
        throw new Error("too many second factor attempts");
      }
      const factor = (
        await db.query(
          `
            SELECT *
              FROM account_second_factors
             WHERE account_id = $1::UUID
               AND type = $2::VARCHAR(32)
               AND status = $3::VARCHAR(32)
             ORDER BY activated_at DESC NULLS LAST, created DESC
             LIMIT 1
          `,
          [accountId, FACTOR_TYPE_TOTP, FACTOR_STATUS_ACTIVE],
        )
      ).rows[0] as FactorRow | undefined;
      if (!factor) {
        throw new Error("two-factor authentication is not enabled");
      }

      let verified = false;
      if (resolvedMethod === "totp") {
        const secret = await decryptFactorSecret(
          factor.id,
          factor.secret_encrypted,
        );
        verified = verifyTotpCode({ secret, code: resolvedCode });
      } else {
        verified = await consumeRecoveryCodeWithDb({
          db,
          account_id: accountId,
          factor_id: factor.id,
          code: resolvedCode,
        });
      }
      if (!verified) {
        await db.query(
          `
            UPDATE account_auth_challenges
               SET attempt_count = attempt_count + 1
             WHERE id = $1::UUID
          `,
          [challenge_id],
        );
        throw new Error("invalid second factor code");
      }

      await markFactorUsedWithDb({ db, factor_id: factor.id });
      await db.query(
        `
          UPDATE account_auth_challenges
             SET attempt_count = attempt_count + 1,
                 factor_verified_at = NOW(),
                 verified_factor_type = $2::VARCHAR(32),
                 completed_at = NOW()
           WHERE id = $1::UUID
        `,
        [challenge_id, resolvedMethod],
      );
      password_verified_at = locked.password_verified_at
        ? new Date(locked.password_verified_at)
        : new Date();
      factor_verified_at = new Date();
    },
  });

  return {
    account_id: accountId,
    factor_level: resolvedMethod,
    password_verified_at,
    factor_verified_at,
    fresh_auth_until: new Date(Date.now() + 15 * 60_000),
  };
}

export async function freshAuthSession({
  req,
  account_id,
  current_password,
  method,
  code,
  duration,
}: {
  req: any;
  account_id: string;
  current_password: string;
  method?: string;
  code?: string;
  duration?: FreshAuthDuration;
}): Promise<{ fresh_auth_until: Date; factor_level: AuthSessionFactorLevel }> {
  const accountId = ensureAccountId(account_id);
  const session = await getCurrentAuthSession({ req, account_id: accountId });
  let factor_level: AuthSessionFactorLevel = "none";
  await withAccountRehomeWriteFence({
    account_id: accountId,
    action: "fresh auth",
    fn: async (db) => {
      factor_level = await verifyFreshAuthInputs({
        account_id: accountId,
        current_password,
        method,
        code,
        db,
      });
    },
  });
  const fresh_auth_until = new Date(
    Date.now() +
      resolveFreshAuthDurationMs({
        duration,
        factor_level,
      }),
  );
  await setCurrentSessionFreshAuth({
    req,
    account_id: accountId,
    factor_level:
      factor_level === "none" ? (session.factor_level ?? "none") : factor_level,
    fresh_auth_until,
  });
  return {
    fresh_auth_until,
    factor_level:
      factor_level === "none" ? (session.factor_level ?? "none") : factor_level,
  };
}

export async function disableTwoFactor({
  req,
  account_id,
}: {
  req: any;
  account_id: string;
}): Promise<void> {
  const accountId = ensureAccountId(account_id);
  await requireFreshAuth({ req, account_id: accountId });
  await withAccountRehomeWriteFence({
    account_id: accountId,
    action: "disable two-factor authentication",
    fn: async (db) => {
      await db.query(
        `
          UPDATE account_second_factors
             SET status = $2::VARCHAR(32),
                 disabled_at = NOW()
           WHERE account_id = $1::UUID
             AND status IN ($3::VARCHAR(32), $4::VARCHAR(32))
        `,
        [
          accountId,
          FACTOR_STATUS_DISABLED,
          FACTOR_STATUS_ACTIVE,
          FACTOR_STATUS_PENDING,
        ],
      );
      await db.query(
        "DELETE FROM account_second_factor_recovery_codes WHERE account_id = $1::UUID",
        [accountId],
      );
    },
  });
}

export async function rotateRecoveryCodes({
  req,
  account_id,
}: {
  req: any;
  account_id: string;
}): Promise<{ recovery_codes: string[] }> {
  const accountId = ensureAccountId(account_id);
  await requireFreshAuth({ req, account_id: accountId });
  const factor = await getActiveFactor(accountId);
  if (!factor) {
    throw new Error("two-factor authentication is not enabled");
  }
  let recovery_codes: string[] = [];
  await withAccountRehomeWriteFence({
    account_id: accountId,
    action: "rotate recovery codes",
    fn: async (db) => {
      recovery_codes = await issueRecoveryCodesWithDb({
        db,
        account_id: accountId,
        factor_id: factor.id,
      });
    },
  });
  return { recovery_codes };
}
