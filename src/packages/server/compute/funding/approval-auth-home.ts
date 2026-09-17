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
import { isValidUUID } from "@cocalc/util/misc";

type ChallengeIdentity = {
  account_id: string;
  metadata?: Record<string, unknown> | null;
};

function requireIdentity(opts: AccountLocalFinancialApprovalAuthRequest): void {
  if (
    !isValidUUID(opts.account_id) ||
    !isValidUUID(opts.intent_id) ||
    new URL(opts.approval_origin).origin !== opts.approval_origin
  ) {
    throw new Error("invalid financial approval authentication request");
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
    row.metadata?.financial_intent_id !== opts.intent_id
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
