/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { AuthenticationResponseJSON } from "@simplewebauthn/server";

import getPool from "@cocalc/database/pool";
import type {
  AccountLocalFinancialApprovalAuthRequest,
  AccountLocalFinancialApprovalAuthResult,
} from "@cocalc/conat/inter-bay/api";
import {
  finishSignInPasskeyAuthentication,
  startSignInPasskeyAuthentication,
} from "@cocalc/server/auth/passkeys";
import {
  createSignInSecondFactorChallenge,
  hasActiveSecondFactor,
  verifySignInSecondFactorChallenge,
} from "@cocalc/server/auth/two-factor";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { isValidUUID } from "@cocalc/util/misc";

type ChallengeIdentity = {
  account_id: string;
  metadata?: Record<string, unknown> | null;
};

function requireIdentity(opts: AccountLocalFinancialApprovalAuthRequest): void {
  const email = `${opts.email_address ?? ""}`.trim().toLowerCase();
  if (
    !isValidUUID(opts.account_id) ||
    !isValidUUID(opts.intent_id) ||
    !email ||
    email !== opts.email_address ||
    new URL(opts.approval_origin).origin !== opts.approval_origin
  ) {
    throw new Error("invalid financial approval authentication request");
  }
}

async function requireCurrentAccountEmail(
  opts: AccountLocalFinancialApprovalAuthRequest,
): Promise<void> {
  const result = await getPool().query(
    `SELECT 1 FROM accounts
      WHERE account_id=$1::UUID
        AND lower(email_address)=$2
        AND deleted IS NOT TRUE
        AND COALESCE(NULLIF(BTRIM(home_bay_id), ''), $3::TEXT)=$3::TEXT`,
    [opts.account_id, opts.email_address, getConfiguredBayId()],
  );
  if (result.rows.length !== 1) {
    throw new Error("financial approval authentication identity mismatch");
  }
}

async function requireBoundChallenge(
  opts: Exclude<AccountLocalFinancialApprovalAuthRequest, { action: "begin" }>,
): Promise<void> {
  const row = (
    await getPool().query<ChallengeIdentity>(
      `SELECT account_id, metadata
         FROM account_auth_challenges
        WHERE id=$1::UUID AND purpose='sign_in'`,
      [opts.challenge_id],
    )
  ).rows[0];
  if (
    row?.account_id !== opts.account_id ||
    row.metadata?.financial_approval_origin !== opts.approval_origin ||
    row.metadata?.financial_intent_id !== opts.intent_id ||
    row.metadata?.financial_approval_email !== opts.email_address
  ) {
    throw new Error("financial approval authentication challenge mismatch");
  }
}

function ready(
  result: Awaited<
    ReturnType<
      | typeof verifySignInSecondFactorChallenge
      | typeof finishSignInPasskeyAuthentication
    >
  >,
): AccountLocalFinancialApprovalAuthResult {
  return {
    state: "ready",
    account_id: result.account_id,
    primary_auth_method: result.primary_auth_method as
      | "password"
      | "email_code"
      | "email_link",
    primary_verified_at: result.primary_verified_at.toISOString(),
    ...(result.password_verified_at
      ? { password_verified_at: result.password_verified_at.toISOString() }
      : {}),
    factor_level: result.factor_level as "totp" | "recovery_code" | "passkey",
    factor_verified_at: result.factor_verified_at.toISOString(),
  };
}

export async function financialApprovalAuthOnHome(
  opts: AccountLocalFinancialApprovalAuthRequest,
): Promise<AccountLocalFinancialApprovalAuthResult> {
  requireIdentity(opts);
  await requireCurrentAccountEmail(opts);
  if (opts.action === "begin") {
    const primaryVerifiedAt = new Date(opts.primary_verified_at);
    if (
      !Number.isFinite(primaryVerifiedAt.valueOf()) ||
      Math.abs(Date.now() - primaryVerifiedAt.valueOf()) > 15 * 60_000
    ) {
      throw new Error("financial approval primary authentication expired");
    }
    if (!(await hasActiveSecondFactor(opts.account_id))) {
      return {
        state: "ready",
        account_id: opts.account_id,
        primary_auth_method: opts.primary_auth_method,
        primary_verified_at: primaryVerifiedAt.toISOString(),
        ...(opts.primary_auth_method === "password"
          ? { password_verified_at: primaryVerifiedAt.toISOString() }
          : {}),
        factor_level: "none",
      };
    }
    const challenge = await createSignInSecondFactorChallenge({
      account_id: opts.account_id,
      primary_auth_method: opts.primary_auth_method,
      primary_verified_at: primaryVerifiedAt,
      metadata: {
        financial_approval_origin: opts.approval_origin,
        financial_intent_id: opts.intent_id,
        financial_approval_email: opts.email_address,
      },
    });
    return {
      state: "second_factor",
      account_id: opts.account_id,
      ...challenge,
    };
  }

  await requireBoundChallenge(opts);
  if (opts.action === "verify-code") {
    return ready(
      await verifySignInSecondFactorChallenge({
        challenge_id: opts.challenge_id,
        method: opts.method,
        code: opts.code,
      }),
    );
  }
  if (opts.action === "start-passkey") {
    if (opts.relying_party.origin !== opts.approval_origin) {
      throw new Error("financial approval passkey origin mismatch");
    }
    const started = await startSignInPasskeyAuthentication({
      challenge_id: opts.challenge_id,
      relying_party: opts.relying_party,
    });
    return {
      state: "passkey",
      challenge_id: started.challenge_id,
      options: started.options as unknown as Record<string, unknown>,
    };
  }
  return ready(
    await finishSignInPasskeyAuthentication({
      challenge_id: opts.challenge_id,
      response: opts.response as unknown as AuthenticationResponseJSON,
    }),
  );
}
