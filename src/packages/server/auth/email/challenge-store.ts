/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";

import getPool from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import getStrategies from "@cocalc/database/settings/get-sso-strategies";
import {
  getEnabledSsoDomainPolicyForEmail,
  passwordSignupBlockedBySsoPolicy,
} from "@cocalc/database/settings/sso-policies";
import { getClusterAccountByEmailDirect } from "@cocalc/server/accounts/cluster-directory";
import { getLogger } from "@cocalc/backend/logger";
import { evaluateAccountCreationPolicy } from "@cocalc/server/auth/account-creation-policy";
import { issueHomeBayRetryToken } from "@cocalc/server/auth/home-bay-retry-token";
import {
  recordSignUpTokenFail,
  signUpTokenCheck,
} from "@cocalc/server/auth/throttle";
import {
  checkRequiredSSO,
  getEmailDomain,
} from "@cocalc/server/auth/sso/check-required-sso";
import getRequiresRegistrationToken from "@cocalc/server/auth/tokens/get-requires-token";
import {
  redeemRegistrationTokenDirect,
  restoreRedeemedRegistrationTokenDirect,
  validateRegistrationTokenDirect,
} from "@cocalc/server/auth/tokens/redeem";
import {
  adminVerifyClusterAccountEmailAddress,
  createClusterAccount,
} from "@cocalc/server/inter-bay/accounts";
import { is_valid_email_address as isValidEmailAddress } from "@cocalc/util/misc";
import { buildMarketingConsentOtherSettings } from "@cocalc/util/notification-preferences";
import {
  onboardingIntentOtherSettings,
  normalizeProjectOnboardingIntent,
} from "@cocalc/util/accounts/onboarding-intent";

import { sendEmailAuthChallengeMessage } from "./delivery";
import {
  createEmailAuthCode,
  createEmailAuthLinkToken,
  decryptEmailAuthRegistrationToken,
  emailAuthDigest,
  emailAuthSecretMatches,
  encryptEmailAuthRegistrationToken,
  maskEmailAddress,
} from "./secrets";
import type {
  EmailAuthChallengePublicStatus,
  EmailAuthChallengeState,
  EmailAuthExchangeResult,
  CompleteEmailAuthMfaOptions,
  CompleteEmailFreshAuthOptions,
  CompletedEmailFreshAuth,
  ConsumedEmailAuthExchange,
  ConsumeEmailAuthExchangeOptions,
  GetEmailAuthChallengeStatusOptions,
  PrepareEmailAuthExchangeOptions,
  RedeemEmailAuthCodeOptions,
  RedeemEmailAuthLinkOptions,
  ResendEmailAuthChallengeOptions,
  StartEmailAuthChallengeOptions,
} from "./types";
import { EmailAuthChallengeError } from "./types";

const logger = getLogger("server:auth:email");
const TABLE = "email_auth_challenges";
const CHALLENGE_TTL_MS = 15 * 60_000;
const RESEND_DELAY_MS = 30_000;
const MAX_ATTEMPTS = 8;
const MAX_SENDS = 5;
const STARTS_PER_EMAIL_PER_HOUR = 10;
const STARTS_PER_IP_PER_HOUR = 30;
let schemaReady: Promise<void> | undefined;

type Queryable = {
  query: <T = any>(
    sql: string,
    params?: any[],
  ) => Promise<{ rows: T[]; rowCount?: number | null }>;
};

type ChallengeRow = {
  challenge_id: string;
  normalized_email: string;
  email_lookup_hash: string;
  account_id?: string | null;
  selected_home_bay_id?: string | null;
  exchange_id?: string | null;
  auth_method?: "email_code" | "email_link" | null;
  purpose: string;
  state: EmailAuthChallengeState;
  code_digest: string;
  link_token_digest: string;
  browser_binding_digest: string;
  attempt_count: number;
  max_attempts: number;
  send_count: number;
  resend_available_at: Date;
  message_sent_at?: Date | null;
  message_failed_at?: Date | null;
  terms_accepted_at?: Date | null;
  terms_version?: string | null;
  registration_token_reservation_id?: string | null;
  registration_token_encrypted?: string | null;
  registration_token_validated_at?: Date | null;
  continuation?: { target?: string; onboarding_intent?: string } | null;
  email_proved_at?: Date | null;
  account_created_at?: Date | null;
  expires_at: Date;
  metadata?: Record<string, unknown> | null;
};

export async function ensureEmailAuthChallengeSchema(): Promise<void> {
  if (schemaReady) {
    return await schemaReady;
  }
  schemaReady = ensureEmailAuthChallengeSchemaInner().catch((err) => {
    schemaReady = undefined;
    throw err;
  });
  return await schemaReady;
}

async function ensureEmailAuthChallengeSchemaInner(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      challenge_id UUID PRIMARY KEY,
      normalized_email VARCHAR(254) NOT NULL,
      email_lookup_hash CHAR(64) NOT NULL,
      account_id UUID,
      selected_home_bay_id VARCHAR(64),
      exchange_id UUID,
      auth_method VARCHAR(32),
      purpose VARCHAR(32) NOT NULL,
      state VARCHAR(32) NOT NULL,
      code_digest CHAR(64) NOT NULL,
      link_token_digest CHAR(64) NOT NULL,
      browser_binding_digest CHAR(64) NOT NULL,
      analytics_token UUID,
      terms_accepted_at TIMESTAMPTZ,
      terms_version TEXT,
      registration_token_reservation_id UUID,
      registration_token_encrypted TEXT,
      registration_token_validated_at TIMESTAMPTZ,
      continuation JSONB,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT ${MAX_ATTEMPTS},
      send_count INTEGER NOT NULL DEFAULT 0,
      resend_available_at TIMESTAMPTZ NOT NULL,
      message_queued_at TIMESTAMPTZ,
      message_sent_at TIMESTAMPTZ,
      message_failed_at TIMESTAMPTZ,
      message_error_code VARCHAR(64),
      first_viewed_at TIMESTAMPTZ,
      email_proved_at TIMESTAMPTZ,
      account_created_at TIMESTAMPTZ,
      session_completed_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      superseded_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      request_ip_hash CHAR(64),
      metadata JSONB NOT NULL DEFAULT '{}'::JSONB
    )
  `);
  await pool.query(`
    ALTER TABLE ${TABLE}
      ADD COLUMN IF NOT EXISTS registration_token_reservation_id UUID,
      ADD COLUMN IF NOT EXISTS registration_token_encrypted TEXT,
      ADD COLUMN IF NOT EXISTS registration_token_validated_at TIMESTAMPTZ
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_email_lookup_hash_idx ON ${TABLE} (email_lookup_hash, created_at DESC)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_account_id_idx ON ${TABLE} (account_id, created_at DESC)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_state_idx ON ${TABLE} (state, updated_at DESC)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_expires_at_idx ON ${TABLE} (expires_at)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_request_ip_hash_idx ON ${TABLE} (request_ip_hash, created_at DESC)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_analytics_token_idx ON ${TABLE} (analytics_token)`,
  );
  await pool.query(
    `UPDATE ${TABLE}
        SET state='expired',
            registration_token_encrypted=NULL,
            updated_at=NOW()
      WHERE state='pending' AND expires_at <= NOW()`,
  );
  await pool.query(
    `DELETE FROM ${TABLE} WHERE created_at < NOW() - INTERVAL '30 days'`,
  );
}

function normalizeEmail(email_address: string): string {
  const email = `${email_address ?? ""}`.trim().toLowerCase();
  if (!email || !isValidEmailAddress(email) || email.length > 254) {
    throw new EmailAuthChallengeError(
      "Enter a valid email address.",
      "invalid",
    );
  }
  return email;
}

function publicStatus(row: ChallengeRow): EmailAuthChallengePublicStatus {
  const now = Date.now();
  const state =
    row.state === "pending" && new Date(row.expires_at).valueOf() <= now
      ? "expired"
      : row.state;
  return {
    challenge_id: row.challenge_id,
    purpose: row.purpose as EmailAuthChallengePublicStatus["purpose"],
    state,
    account_created: row.account_created_at != null,
    masked_email: maskEmailAddress(row.normalized_email),
    expires_at: new Date(row.expires_at).toISOString(),
    resend_available_at: new Date(row.resend_available_at).toISOString(),
    send_count: Number(row.send_count ?? 0),
    message_sent: row.message_sent_at != null,
    message_failed: row.message_failed_at != null,
    message_sent_now: false,
  };
}

function isPrivilegedRegistrationToken(customize: unknown): boolean {
  if (!customize || typeof customize !== "object") {
    return false;
  }
  const value = customize as { bootstrap?: boolean; make_admin?: boolean };
  return value.bootstrap === true || value.make_admin === true;
}

async function requiresRegistrationTokenForEmail(email: string) {
  const ssoDomainPolicy = await getEnabledSsoDomainPolicyForEmail(email);
  return {
    requiresRegistrationToken:
      ssoDomainPolicy?.signup_mode === "public_allowed"
        ? false
        : ssoDomainPolicy?.signup_mode === "registration_token_required"
          ? true
          : await getRequiresRegistrationToken(),
    ssoDomainPolicy,
  };
}

async function registrationTokenMatchesChallenge({
  row,
  token,
}: {
  row: ChallengeRow;
  token?: string;
}): Promise<boolean> {
  const supplied = `${token ?? ""}`.trim();
  if (!row.registration_token_encrypted) {
    return !supplied;
  }
  if (!supplied) {
    return false;
  }
  try {
    return (
      (await decryptEmailAuthRegistrationToken(
        row.registration_token_encrypted,
      )) === supplied
    );
  } catch {
    return false;
  }
}

async function assertStartRateLimit({
  db,
  email_lookup_hash,
  request_ip_hash,
}: {
  db: Queryable;
  email_lookup_hash: string;
  request_ip_hash?: string;
}): Promise<void> {
  const { rows } = await db.query<{
    email_count: number;
    ip_count: number;
  }>(
    `
      SELECT
        COUNT(*) FILTER (WHERE email_lookup_hash=$1)::INTEGER AS email_count,
        COUNT(*) FILTER (
          WHERE $2::CHAR(64) IS NOT NULL AND request_ip_hash=$2
        )::INTEGER AS ip_count
      FROM ${TABLE}
      WHERE created_at > NOW() - INTERVAL '1 hour'
        AND (
          email_lookup_hash=$1 OR
          ($2::CHAR(64) IS NOT NULL AND request_ip_hash=$2)
        )
    `,
    [email_lookup_hash, request_ip_hash ?? null],
  );
  if (
    Number(rows[0]?.email_count ?? 0) >= STARTS_PER_EMAIL_PER_HOUR ||
    Number(rows[0]?.ip_count ?? 0) >= STARTS_PER_IP_PER_HOUR
  ) {
    throw new EmailAuthChallengeError(
      "Too many email sign-in requests. Wait before trying again.",
      "rate_limited",
    );
  }
}

async function deliverChallenge({
  challenge_id,
  code,
  email_address,
  link_token,
  purpose,
  code_only,
}: {
  challenge_id: string;
  code: string;
  email_address: string;
  link_token: string;
  purpose: EmailAuthChallengePublicStatus["purpose"];
  code_only?: boolean;
}): Promise<void> {
  const pool = getPool();
  try {
    await sendEmailAuthChallengeMessage({
      challenge_id,
      code,
      email_address,
      link_token,
      purpose,
      code_only,
    });
    await pool.query(
      `
        UPDATE ${TABLE}
           SET message_sent_at=NOW(),
               message_failed_at=NULL,
               message_error_code=NULL,
               updated_at=NOW()
         WHERE challenge_id=$1
      `,
      [challenge_id],
    );
  } catch (err) {
    const errorCode =
      err instanceof Error && err.name
        ? err.name.toLowerCase().slice(0, 64)
        : "delivery_error";
    await pool.query(
      `
        UPDATE ${TABLE}
           SET message_failed_at=NOW(),
               message_error_code=$2,
               updated_at=NOW()
         WHERE challenge_id=$1
      `,
      [challenge_id, errorCode],
    );
    logger.warn("email auth delivery failed", {
      challenge_id,
      error_code: errorCode,
    });
    throw new Error("Unable to send the sign-in email. Please try again.");
  }
}

export async function startEmailAuthChallengeDirect(
  opts: StartEmailAuthChallengeOptions,
): Promise<EmailAuthChallengePublicStatus> {
  await ensureEmailAuthChallengeSchema();
  const email = normalizeEmail(opts.email_address);
  const purpose = opts.purpose ?? "sign_in_or_sign_up";
  const challenge_id = randomUUID();
  const code = createEmailAuthCode();
  const linkToken = createEmailAuthLinkToken();
  const [
    emailLookupHash,
    requestIpHash,
    codeDigest,
    linkTokenDigest,
    browserBindingDigest,
    account,
  ] = await Promise.all([
    emailAuthDigest({ kind: "email", value: email }),
    opts.request_ip
      ? emailAuthDigest({ kind: "ip", value: opts.request_ip })
      : undefined,
    emailAuthDigest({ challenge_id, kind: "code", value: code }),
    emailAuthDigest({ challenge_id, kind: "link", value: linkToken }),
    emailAuthDigest({
      challenge_id,
      kind: "browser",
      value: opts.browser_binding,
    }),
    getClusterAccountByEmailDirect(email),
  ]);
  if (
    opts.expected_account_id &&
    account?.account_id !== opts.expected_account_id
  ) {
    throw new EmailAuthChallengeError(
      "This email address does not match the signed-in account.",
      "not_allowed",
    );
  }
  if (purpose === "email_fresh_auth" && !account?.account_id) {
    throw new EmailAuthChallengeError(
      "Fresh authentication requires an existing account.",
      "not_allowed",
    );
  }
  const registrationToken = `${opts.registration_token ?? ""}`.trim();
  let registrationTokenReservationId: string | undefined;
  let registrationTokenEncrypted: string | undefined;
  let registrationTokenValidatedAt: Date | undefined;
  if (purpose === "sign_in_or_sign_up" && registrationToken) {
    const { requiresRegistrationToken } =
      await requiresRegistrationTokenForEmail(email);
    if (requiresRegistrationToken) {
      const tokenThrottle = signUpTokenCheck(email, opts.request_ip);
      if (tokenThrottle) {
        throw new EmailAuthChallengeError(tokenThrottle, "rate_limited");
      }
      try {
        const tokenInfo = await validateRegistrationTokenDirect(
          registrationToken,
          { required: true },
        );
        if (isPrivilegedRegistrationToken(tokenInfo?.customize)) {
          throw new EmailAuthChallengeError(
            "Administrator and bootstrap registration tokens require password signup.",
            "not_allowed",
          );
        }
      } catch (err) {
        if (err instanceof EmailAuthChallengeError) {
          throw err;
        }
        recordSignUpTokenFail(email, opts.request_ip);
        throw new EmailAuthChallengeError(
          `Registration token was not accepted -- ${err instanceof Error ? err.message : err}`,
          "invalid",
        );
      }
      registrationTokenReservationId = randomUUID();
      registrationTokenEncrypted =
        await encryptEmailAuthRegistrationToken(registrationToken);
      registrationTokenValidatedAt = new Date();
    }
  }
  const pool = getPool();
  const db = await pool.connect();
  let row: ChallengeRow;
  try {
    await db.query("BEGIN");
    const active = (
      await db.query<ChallengeRow>(
        `
          SELECT *
            FROM ${TABLE}
           WHERE email_lookup_hash=$1
             AND purpose=$2
             AND state='pending'
             AND expires_at > NOW()
           ORDER BY created_at DESC
           LIMIT 1
           FOR UPDATE
        `,
        [emailLookupHash, purpose],
      )
    ).rows[0];
    if (
      active &&
      (await emailAuthSecretMatches({
        challenge_id: active.challenge_id,
        digest: active.browser_binding_digest,
        kind: "browser",
        value: opts.browser_binding,
      })) &&
      (await registrationTokenMatchesChallenge({
        row: active,
        token: registrationTokenEncrypted ? registrationToken : undefined,
      }))
    ) {
      await db.query("COMMIT");
      return publicStatus(active);
    }
    await assertStartRateLimit({
      db,
      email_lookup_hash: emailLookupHash,
      request_ip_hash: requestIpHash,
    });
    await db.query(
      `
        UPDATE ${TABLE}
           SET state='superseded',
               superseded_at=NOW(),
               registration_token_encrypted=NULL,
               updated_at=NOW()
         WHERE email_lookup_hash=$1
           AND purpose=$2
           AND state='pending'
           AND expires_at > NOW()
      `,
      [emailLookupHash, purpose],
    );
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
    const resendAvailableAt = new Date(Date.now() + RESEND_DELAY_MS);
    row = (
      await db.query<ChallengeRow>(
        `
          INSERT INTO ${TABLE} (
            challenge_id, normalized_email, email_lookup_hash, account_id,
            selected_home_bay_id, purpose, state, code_digest,
            link_token_digest, browser_binding_digest, analytics_token,
            terms_accepted_at, terms_version,
            registration_token_reservation_id,
            registration_token_encrypted, registration_token_validated_at,
            continuation,
            attempt_count, max_attempts, send_count, resend_available_at,
            message_queued_at, expires_at, request_ip_hash, metadata
          ) VALUES (
            $1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16::JSONB, 0, $17, 1, $18,
            NOW(), $19, $20,
            $21::JSONB
          )
          RETURNING *
        `,
        [
          challenge_id,
          email,
          emailLookupHash,
          account?.account_id ?? null,
          account?.home_bay_id ?? opts.prospective_home_bay_id ?? null,
          purpose,
          codeDigest,
          linkTokenDigest,
          browserBindingDigest,
          opts.analytics_token || null,
          opts.terms_accepted ? new Date() : null,
          `${opts.terms_version ?? ""}`.trim() || null,
          registrationTokenReservationId ?? null,
          registrationTokenEncrypted ?? null,
          registrationTokenValidatedAt ?? null,
          opts.continuation_target || opts.onboarding_intent
            ? JSON.stringify({
                target: opts.continuation_target,
                onboarding_intent: opts.onboarding_intent,
              })
            : null,
          MAX_ATTEMPTS,
          resendAvailableAt,
          expiresAt,
          requestIpHash ?? null,
          JSON.stringify({ code_only: opts.code_only === true }),
        ],
      )
    ).rows[0];
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
  await deliverChallenge({
    challenge_id,
    code,
    email_address: email,
    link_token: linkToken,
    purpose,
    code_only: opts.code_only === true,
  });
  return {
    ...publicStatus(row),
    message_sent: true,
    message_failed: false,
    message_sent_now: true,
  };
}

async function getBoundChallenge({
  challenge_id,
  browser_binding,
}: GetEmailAuthChallengeStatusOptions): Promise<ChallengeRow> {
  await ensureEmailAuthChallengeSchema();
  const row = (
    await getPool().query<ChallengeRow>(
      `SELECT * FROM ${TABLE} WHERE challenge_id=$1`,
      [challenge_id],
    )
  ).rows[0];
  if (
    !row ||
    !(await emailAuthSecretMatches({
      challenge_id,
      digest: row.browser_binding_digest,
      kind: "browser",
      value: browser_binding,
    }))
  ) {
    throw new EmailAuthChallengeError("Challenge not found.", "not_found");
  }
  return row;
}

export async function getEmailAuthChallengeStatusDirect(
  opts: GetEmailAuthChallengeStatusOptions,
): Promise<EmailAuthChallengePublicStatus> {
  const row = await getBoundChallenge(opts);
  if (
    row.state === "pending" &&
    new Date(row.expires_at).valueOf() <= Date.now()
  ) {
    await getPool().query(
      `UPDATE ${TABLE}
          SET state='expired',
              registration_token_encrypted=NULL,
              updated_at=NOW()
        WHERE challenge_id=$1 AND state='pending'`,
      [row.challenge_id],
    );
    row.state = "expired";
  }
  await getPool().query(
    `UPDATE ${TABLE} SET first_viewed_at=NOW() WHERE challenge_id=$1 AND first_viewed_at IS NULL`,
    [row.challenge_id],
  );
  return publicStatus(row);
}

export async function resendEmailAuthChallengeDirect(
  opts: ResendEmailAuthChallengeOptions,
): Promise<EmailAuthChallengePublicStatus> {
  await ensureEmailAuthChallengeSchema();
  const pool = getPool();
  const db = await pool.connect();
  let row: ChallengeRow;
  let code: string;
  let linkToken: string;
  try {
    await db.query("BEGIN");
    const current = (
      await db.query<ChallengeRow>(
        `SELECT * FROM ${TABLE} WHERE challenge_id=$1 FOR UPDATE`,
        [opts.challenge_id],
      )
    ).rows[0];
    if (
      !current ||
      !(await emailAuthSecretMatches({
        challenge_id: opts.challenge_id,
        digest: current.browser_binding_digest,
        kind: "browser",
        value: opts.browser_binding,
      }))
    ) {
      throw new EmailAuthChallengeError("Challenge not found.", "not_found");
    }
    if (
      current.state !== "pending" ||
      new Date(current.expires_at).valueOf() <= Date.now()
    ) {
      throw new EmailAuthChallengeError(
        "This sign-in challenge has expired.",
        "expired",
      );
    }
    if (new Date(current.resend_available_at).valueOf() > Date.now()) {
      throw new EmailAuthChallengeError(
        "Wait before requesting another email.",
        "resend_too_soon",
      );
    }
    if (Number(current.send_count) >= MAX_SENDS) {
      throw new EmailAuthChallengeError(
        "Too many messages were sent for this challenge.",
        "rate_limited",
      );
    }
    code = createEmailAuthCode();
    linkToken = createEmailAuthLinkToken();
    const [codeDigest, linkTokenDigest] = await Promise.all([
      emailAuthDigest({
        challenge_id: current.challenge_id,
        kind: "code",
        value: code,
      }),
      emailAuthDigest({
        challenge_id: current.challenge_id,
        kind: "link",
        value: linkToken,
      }),
    ]);
    row = (
      await db.query<ChallengeRow>(
        `
          UPDATE ${TABLE}
             SET code_digest=$2,
                 link_token_digest=$3,
                 send_count=send_count+1,
                 resend_available_at=$4,
                 message_queued_at=NOW(),
                 message_failed_at=NULL,
                 message_error_code=NULL,
                 updated_at=NOW()
           WHERE challenge_id=$1
           RETURNING *
        `,
        [
          current.challenge_id,
          codeDigest,
          linkTokenDigest,
          new Date(Date.now() + RESEND_DELAY_MS),
        ],
      )
    ).rows[0];
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
  await deliverChallenge({
    challenge_id: row.challenge_id,
    code,
    email_address: row.normalized_email,
    link_token: linkToken,
    purpose: row.purpose as EmailAuthChallengePublicStatus["purpose"],
    code_only: row.metadata?.code_only === true,
  });
  return {
    ...publicStatus(row),
    message_sent: true,
    message_failed: false,
    message_sent_now: true,
  };
}

async function redeemSecret({
  challenge_id,
  kind,
  value,
}: {
  challenge_id: string;
  kind: "code" | "link";
  value: string;
}): Promise<EmailAuthChallengePublicStatus> {
  await ensureEmailAuthChallengeSchema();
  const pool = getPool();
  const db = await pool.connect();
  let transactionOpen = false;
  try {
    await db.query("BEGIN");
    transactionOpen = true;
    const row = (
      await db.query<ChallengeRow>(
        `SELECT * FROM ${TABLE} WHERE challenge_id=$1 FOR UPDATE`,
        [challenge_id],
      )
    ).rows[0];
    if (!row) {
      throw new EmailAuthChallengeError("Challenge not found.", "not_found");
    }
    const provedState = [
      "email_proved",
      "account_creating",
      "account_ready",
    ].includes(row.state);
    if (
      (!provedState && row.state !== "pending") ||
      (row.state === "pending" &&
        new Date(row.expires_at).valueOf() <= Date.now())
    ) {
      throw new EmailAuthChallengeError(
        "This sign-in challenge has expired.",
        "expired",
      );
    }
    if (Number(row.attempt_count) >= Number(row.max_attempts)) {
      throw new EmailAuthChallengeError(
        "This sign-in challenge is blocked.",
        "blocked",
      );
    }
    const valid = await emailAuthSecretMatches({
      challenge_id,
      digest: kind === "code" ? row.code_digest : row.link_token_digest,
      kind,
      value,
    });
    if (provedState) {
      if (!valid) {
        throw new EmailAuthChallengeError(
          "The code or link is not valid.",
          "invalid",
        );
      }
      await db.query("COMMIT");
      transactionOpen = false;
      return publicStatus(row);
    }
    if (!valid) {
      const blocked = Number(row.attempt_count) + 1 >= Number(row.max_attempts);
      await db.query(
        `
          UPDATE ${TABLE}
             SET attempt_count=attempt_count+1,
                 state=CASE WHEN attempt_count+1 >= max_attempts THEN 'blocked' ELSE state END,
                 updated_at=NOW()
           WHERE challenge_id=$1
        `,
        [challenge_id],
      );
      await db.query("COMMIT");
      transactionOpen = false;
      throw new EmailAuthChallengeError(
        blocked
          ? "This sign-in challenge is blocked."
          : "The code or link is not valid.",
        blocked ? "blocked" : "invalid",
      );
    }
    const proved = (
      await db.query<ChallengeRow>(
        `
          UPDATE ${TABLE}
             SET state='email_proved',
                 auth_method=$2::TEXT,
                 email_proved_at=NOW(),
                 updated_at=NOW(),
                 metadata=metadata || jsonb_build_object('auth_method', $2::TEXT)
           WHERE challenge_id=$1
           RETURNING *
        `,
        [challenge_id, kind === "code" ? "email_code" : "email_link"],
      )
    ).rows[0];
    await db.query("COMMIT");
    transactionOpen = false;
    return publicStatus(proved);
  } catch (err) {
    if (transactionOpen) {
      await db.query("ROLLBACK");
    }
    throw err;
  } finally {
    db.release();
  }
}

export async function redeemEmailAuthCodeDirect(
  opts: RedeemEmailAuthCodeOptions,
): Promise<EmailAuthChallengePublicStatus> {
  const code = `${opts.code ?? ""}`.replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) {
    throw new EmailAuthChallengeError("Enter the six-digit code.", "invalid");
  }
  return await redeemSecret({
    challenge_id: opts.challenge_id,
    kind: "code",
    value: code,
  });
}

export async function redeemEmailAuthLinkDirect(
  opts: RedeemEmailAuthLinkOptions,
): Promise<EmailAuthChallengePublicStatus> {
  const token = `${opts.token ?? ""}`.trim();
  if (token.length < 32) {
    throw new EmailAuthChallengeError(
      "The sign-in link is invalid.",
      "invalid",
    );
  }
  return await redeemSecret({
    challenge_id: opts.challenge_id,
    kind: "link",
    value: token,
  });
}

function exchangeResult(row: ChallengeRow): EmailAuthExchangeResult {
  if (
    !row.account_id ||
    !row.selected_home_bay_id ||
    !row.exchange_id ||
    !row.auth_method
  ) {
    throw new Error("email authentication exchange is incomplete");
  }
  const issued = issueHomeBayRetryToken({
    account_id: row.account_id,
    challenge_id: row.challenge_id,
    email: row.normalized_email,
    home_bay_id: row.selected_home_bay_id,
    purpose: "email-auth",
    primary_auth_method: row.auth_method,
    primary_verified_at: new Date(
      row.email_proved_at ?? new Date(),
    ).toISOString(),
    token_id: row.exchange_id,
    ttl_seconds: 60,
  });
  return {
    challenge_id: row.challenge_id,
    account_created: row.account_created_at != null,
    exchange_token: issued.token,
    exchange_expires_at: new Date(issued.expires_at).toISOString(),
    home_bay_id: row.selected_home_bay_id,
    redirect_to: `${row.continuation?.target ?? ""}`.trim() || undefined,
    state: "account_ready",
  };
}

async function resolveChallengeAccount(
  row: ChallengeRow,
  auth_method: "email_code" | "email_link",
): Promise<{
  account_created: boolean;
  account_id: string;
  home_bay_id: string;
}> {
  const existing = await getClusterAccountByEmailDirect(row.normalized_email);
  if (existing?.account_id) {
    if (existing.banned) {
      throw new EmailAuthChallengeError(
        "This account is not allowed to sign in.",
        "not_allowed",
      );
    }
    const home_bay_id = `${existing.home_bay_id ?? ""}`.trim();
    if (!home_bay_id) {
      throw new Error("existing account does not have a home bay");
    }
    await adminVerifyClusterAccountEmailAddress({
      account_id: existing.account_id,
    });
    return {
      account_created: false,
      account_id: existing.account_id,
      home_bay_id,
    };
  }

  const settings = await getServerSettings();
  if (settings.email_signup !== true) {
    throw new EmailAuthChallengeError(
      "New email accounts are not enabled for this site.",
      "not_allowed",
    );
  }
  if (!row.terms_accepted_at) {
    throw new EmailAuthChallengeError(
      "Accept the Terms of Service before creating an account.",
      "not_allowed",
    );
  }

  const [registrationPolicy, requiredSsoStrategy] = await Promise.all([
    requiresRegistrationTokenForEmail(row.normalized_email),
    getStrategies().then((strategies) =>
      checkRequiredSSO({
        email: row.normalized_email,
        strategies,
      }),
    ),
  ]);
  const { requiresRegistrationToken, ssoDomainPolicy } = registrationPolicy;
  const registrationTokenValidated =
    !requiresRegistrationToken ||
    (!!row.registration_token_reservation_id &&
      !!row.registration_token_encrypted &&
      !!row.registration_token_validated_at);
  const ssoRequiredDomain = passwordSignupBlockedBySsoPolicy(ssoDomainPolicy)
    ? ssoDomainPolicy?.domain
    : requiredSsoStrategy != null
      ? getEmailDomain(row.normalized_email)
      : undefined;
  const policy = evaluateAccountCreationPolicy({
    auth_method,
    email: row.normalized_email,
    email_verified: true,
    requires_registration_token: requiresRegistrationToken,
    registration_token_validated: registrationTokenValidated,
    sso_required_domain: ssoRequiredDomain,
    signup_disabled_domain:
      ssoDomainPolicy?.signup_mode === "disabled"
        ? ssoDomainPolicy.domain
        : undefined,
  });
  if (policy.type !== "allow_create") {
    const message =
      policy.type === "deny_registration_token_required"
        ? "A registration token is required to create this account."
        : policy.type === "deny_use_sso"
          ? `Continue with your organization's single sign-on for @${policy.domain}.`
          : "An account cannot be created with this email address.";
    throw new EmailAuthChallengeError(message, "not_allowed");
  }
  if (ssoDomainPolicy?.require_cocalc_2fa) {
    throw new EmailAuthChallengeError(
      `Account creation is disabled for "@${ssoDomainPolicy.domain}" because that domain requires CoCalc two-factor authentication.`,
      "not_allowed",
    );
  }

  const home_bay_id = `${row.selected_home_bay_id ?? ""}`.trim();
  if (!home_bay_id) {
    throw new Error("email authentication challenge has no selected home bay");
  }
  let registrationToken: string | undefined;
  let tokenInfo:
    | Awaited<ReturnType<typeof redeemRegistrationTokenDirect>>
    | undefined;
  let tokenRedeemed = false;
  if (requiresRegistrationToken) {
    try {
      registrationToken = await decryptEmailAuthRegistrationToken(
        row.registration_token_encrypted!,
      );
      tokenInfo = await redeemRegistrationTokenDirect(registrationToken, {
        required: true,
      });
      tokenRedeemed = true;
      if (isPrivilegedRegistrationToken(tokenInfo?.customize)) {
        await restoreRedeemedRegistrationTokenDirect(registrationToken);
        tokenRedeemed = false;
        throw new EmailAuthChallengeError(
          "Administrator and bootstrap registration tokens require password signup.",
          "not_allowed",
        );
      }
    } catch (err) {
      if (err instanceof EmailAuthChallengeError) {
        throw err;
      }
      throw new EmailAuthChallengeError(
        `Registration token can no longer be used -- ${err instanceof Error ? err.message : err}`,
        "not_allowed",
      );
    }
  }
  let account;
  let accountCreated = false;
  const onboardingIntent = normalizeProjectOnboardingIntent(
    row.continuation?.onboarding_intent,
  );
  try {
    account = await createClusterAccount({
      email_address: row.normalized_email,
      display_name: "CoCalc User",
      home_bay_id,
      ephemeral: tokenInfo?.ephemeral,
      other_settings: {
        ...buildMarketingConsentOtherSettings(false),
        ...onboardingIntentOtherSettings(onboardingIntent),
      },
      signup_reason: onboardingIntent,
      trusted_product_access: requiresRegistrationToken,
      trusted_product_access_reason: requiresRegistrationToken
        ? "registration_token"
        : undefined,
      verified_email: {
        address: row.normalized_email,
        verified_at: (row.email_proved_at ?? new Date()).toISOString(),
        method: auth_method,
      },
    });
    accountCreated = true;
  } catch (err) {
    if (tokenRedeemed && registrationToken) {
      await restoreRedeemedRegistrationTokenDirect(registrationToken);
      tokenRedeemed = false;
    }
    // Another verified flow may have won the global email reservation.
    account = await getClusterAccountByEmailDirect(row.normalized_email);
    if (!account?.account_id) {
      throw err;
    }
    if (account.banned) {
      throw new EmailAuthChallengeError(
        "This account is not allowed to sign in.",
        "not_allowed",
      );
    }
  }
  const account_id = `${account.account_id ?? ""}`.trim();
  const resolvedHomeBayId =
    `${account.home_bay_id ?? ""}`.trim() || home_bay_id;
  if (!account_id) {
    if (tokenRedeemed && registrationToken) {
      await restoreRedeemedRegistrationTokenDirect(registrationToken);
    }
    throw new Error("account creation did not return an account id");
  }
  await adminVerifyClusterAccountEmailAddress({ account_id });
  return {
    account_created: accountCreated,
    account_id,
    home_bay_id: resolvedHomeBayId,
  };
}

export async function prepareEmailAuthExchangeDirect(
  opts: PrepareEmailAuthExchangeOptions,
): Promise<EmailAuthExchangeResult> {
  await ensureEmailAuthChallengeSchema();
  const pool = getPool();
  const db = await pool.connect();
  let row: ChallengeRow;
  try {
    await db.query("BEGIN");
    row = (
      await db.query<ChallengeRow>(
        `SELECT * FROM ${TABLE} WHERE challenge_id=$1 FOR UPDATE`,
        [opts.challenge_id],
      )
    ).rows[0];
    if (!row) {
      throw new EmailAuthChallengeError("Challenge not found.", "not_found");
    }
    if (
      row.purpose !== "sign_in_or_sign_up" ||
      row.auth_method !== opts.auth_method ||
      !row.email_proved_at ||
      !["email_proved", "account_creating", "account_ready"].includes(row.state)
    ) {
      throw new EmailAuthChallengeError(
        "Email proof is required before continuing.",
        "invalid",
      );
    }
    if (row.state === "account_ready") {
      await db.query("COMMIT");
      return exchangeResult(row);
    }
    if (row.state === "account_creating") {
      throw new EmailAuthChallengeError(
        "Account preparation is already in progress. Try again shortly.",
        "rate_limited",
      );
    }
    await db.query(
      `UPDATE ${TABLE} SET state='account_creating', updated_at=NOW() WHERE challenge_id=$1`,
      [row.challenge_id],
    );
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }

  try {
    const account = await resolveChallengeAccount(row, opts.auth_method);
    const exchange_id = randomUUID();
    const ready = (
      await pool.query<ChallengeRow>(
        `
          UPDATE ${TABLE}
             SET state='account_ready',
                 account_id=$2,
                 selected_home_bay_id=$3,
                 exchange_id=$4,
                 account_created_at=CASE
                   WHEN $5::BOOLEAN THEN NOW()
                   ELSE account_created_at
                 END,
                 registration_token_encrypted=NULL,
                 updated_at=NOW()
           WHERE challenge_id=$1
             AND state='account_creating'
           RETURNING *
        `,
        [
          row.challenge_id,
          account.account_id,
          account.home_bay_id,
          exchange_id,
          account.account_created,
        ],
      )
    ).rows[0];
    if (!ready) {
      throw new Error("email authentication challenge changed unexpectedly");
    }
    return exchangeResult(ready);
  } catch (err) {
    const blocked =
      err instanceof EmailAuthChallengeError && err.code === "not_allowed";
    await pool.query(
      `
        UPDATE ${TABLE}
           SET state=$2::VARCHAR(32),
               registration_token_encrypted=CASE
                 WHEN $2::VARCHAR(32)='blocked' THEN NULL
                 ELSE registration_token_encrypted
               END,
               updated_at=NOW(),
               metadata=metadata || jsonb_build_object(
                 'completion_error', $3::TEXT
               )
         WHERE challenge_id=$1
           AND state='account_creating'
      `,
      [
        row.challenge_id,
        blocked ? "blocked" : "email_proved",
        blocked ? "not_allowed" : "transient",
      ],
    );
    throw err;
  }
}

export async function consumeEmailAuthExchangeDirect(
  opts: ConsumeEmailAuthExchangeOptions,
): Promise<ConsumedEmailAuthExchange> {
  await ensureEmailAuthChallengeSchema();
  const { rows } = await getPool().query<ChallengeRow>(
    `
      UPDATE ${TABLE}
         SET state=$5::VARCHAR(32),
             completed_at=CASE WHEN $6::BOOLEAN THEN NOW() ELSE completed_at END,
             session_completed_at=CASE WHEN $6::BOOLEAN THEN NOW() ELSE session_completed_at END,
             updated_at=NOW()
       WHERE challenge_id=$1
         AND exchange_id=$2
         AND account_id=$3
         AND selected_home_bay_id=$4
         AND state='account_ready'
       RETURNING *
    `,
    [
      opts.challenge_id,
      opts.exchange_id,
      opts.account_id,
      opts.home_bay_id,
      opts.completion,
      opts.completion === "completed",
    ],
  );
  const row = rows[0];
  if (!row?.account_id || !row.auth_method || !row.email_proved_at) {
    throw new EmailAuthChallengeError(
      "This email sign-in exchange has already been used or is invalid.",
      "invalid",
    );
  }
  return {
    account_id: row.account_id,
    auth_method: row.auth_method,
    email_proved_at: new Date(row.email_proved_at).toISOString(),
  };
}

export async function completeEmailAuthMfaDirect(
  opts: CompleteEmailAuthMfaOptions,
): Promise<void> {
  await ensureEmailAuthChallengeSchema();
  const result = await getPool().query(
    `
      UPDATE ${TABLE}
         SET state='completed',
             completed_at=NOW(),
             session_completed_at=NOW(),
             updated_at=NOW()
       WHERE challenge_id=$1
         AND account_id=$2
         AND selected_home_bay_id=$3
         AND state='mfa_required'
    `,
    [opts.challenge_id, opts.account_id, opts.home_bay_id],
  );
  if (result.rowCount !== 1) {
    throw new EmailAuthChallengeError(
      "This email sign-in challenge is not awaiting a second factor.",
      "invalid",
    );
  }
}

export async function completeEmailFreshAuthDirect(
  opts: CompleteEmailFreshAuthOptions,
): Promise<CompletedEmailFreshAuth> {
  await ensureEmailAuthChallengeSchema();
  const { rows } = await getPool().query<ChallengeRow>(
    `
      UPDATE ${TABLE}
         SET state='completed',
             completed_at=NOW(),
             session_completed_at=NOW(),
             updated_at=NOW()
       WHERE challenge_id=$1
         AND account_id=$2
         AND purpose='email_fresh_auth'
         AND state='email_proved'
       RETURNING *
    `,
    [opts.challenge_id, opts.account_id],
  );
  const row = rows[0];
  if (!row?.auth_method || !row.email_proved_at) {
    throw new EmailAuthChallengeError(
      "This email approval is invalid or has already been used.",
      "invalid",
    );
  }
  return {
    auth_method: row.auth_method,
    email_proved_at: new Date(row.email_proved_at).toISOString(),
  };
}
