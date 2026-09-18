/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { createHash, randomBytes } from "node:crypto";

import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import {
  createInterBayAccountLocalClient,
  type AccountLocalFinancialApprovalAuthRequest,
  type AccountLocalFinancialApprovalAuthResult,
} from "@cocalc/conat/inter-bay/api";
import {
  completeEmailFreshAuthDirect,
  getEmailAuthChallengeStatusDirect,
  redeemEmailAuthCodeDirect,
  startEmailAuthChallengeDirect,
} from "@cocalc/server/auth/email/challenge-store";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  getClusterAccountByEmail,
  verifyClusterAccountSignInPassword,
} from "@cocalc/server/inter-bay/accounts";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { financialApprovalAuthOnHome } from "./approval-auth-home";

export type FundingApprovalPendingAuth = {
  account_id: string;
  email_address: string;
  home_bay_id: string;
  intent_id: string;
  origin: string;
  email_challenge_id?: string;
  second_factor_challenge_id?: string;
  methods?: Array<"totp" | "recovery_code" | "passkey">;
  expires_at: number;
};

export type FundingApprovalReadyAuth = Extract<
  AccountLocalFinancialApprovalAuthResult,
  { state: "ready" }
>;

interface FundingApprovalSessionRow {
  session_hash: string;
  account_id: string;
  approval_origin: string;
  primary_auth_method: string;
  primary_verified_at: Date;
  factor_level: string;
  factor_verified_at: Date | null;
  authenticated_for_intent_id: string;
  expire: Date;
  revoked_at: Date | null;
}

export function fundingSessionHash(token: string): string {
  if (!/^[a-f0-9]{64}$/.test(token)) {
    throw new Error("Financial sign-in required");
  }
  return createHash("sha256").update(token).digest("hex");
}

async function accountForEmail(email_address: string) {
  const email = `${email_address ?? ""}`.trim().toLowerCase();
  const account = await getClusterAccountByEmail(email);
  if (!account?.account_id || !account.home_bay_id) {
    throw new Error("Financial sign-in failed");
  }
  return {
    account: {
      ...account,
      account_id: account.account_id,
      home_bay_id: account.home_bay_id,
    },
    email,
  };
}

export async function requireFundingApprovalEmailForPayer(opts: {
  email_address: string;
  payer_account_id: string;
}): Promise<void> {
  const { account } = await accountForEmail(opts.email_address);
  if (account.account_id !== opts.payer_account_id) {
    throw new Error("Financial sign-in failed");
  }
}

async function homeAuth(
  home_bay_id: string,
  request: AccountLocalFinancialApprovalAuthRequest,
): Promise<AccountLocalFinancialApprovalAuthResult> {
  if (home_bay_id === getConfiguredBayId()) {
    return await financialApprovalAuthOnHome(request);
  }
  return await createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: home_bay_id,
  }).financialApprovalAuth(request);
}

function pending(
  base: Omit<FundingApprovalPendingAuth, "expires_at">,
): FundingApprovalPendingAuth {
  return { ...base, expires_at: Date.now() + 15 * 60_000 };
}

function requirePending(value: FundingApprovalPendingAuth): void {
  if (value.expires_at <= Date.now()) {
    throw new Error("Financial sign-in expired");
  }
}

async function beginSecondFactor(
  auth: FundingApprovalPendingAuth,
  primary_auth_method: "password" | "email_code" | "email_link",
  primary_verified_at: Date,
): Promise<FundingApprovalPendingAuth | FundingApprovalReadyAuth> {
  const result = await homeAuth(auth.home_bay_id, {
    action: "begin",
    account_id: auth.account_id,
    approval_origin: auth.origin,
    intent_id: auth.intent_id,
    primary_auth_method,
    primary_verified_at: primary_verified_at.toISOString(),
  });
  if (result.state === "ready") return result;
  if (result.state !== "second_factor") {
    throw new Error("Financial sign-in failed");
  }
  return pending({
    ...auth,
    second_factor_challenge_id: result.challenge_id,
    methods: result.methods,
  });
}

export async function beginFundingApprovalPassword(opts: {
  email_address: string;
  password: string;
  intent_id: string;
  origin: string;
}): Promise<FundingApprovalPendingAuth | FundingApprovalReadyAuth> {
  const { account, email } = await accountForEmail(opts.email_address);
  const verified = await verifyClusterAccountSignInPassword({
    home_bay_id: account.home_bay_id,
    email_address: email,
    password: opts.password,
  });
  if (verified.account_id !== account.account_id) {
    throw new Error("Financial sign-in failed");
  }
  return await beginSecondFactor(
    pending({
      account_id: account.account_id,
      email_address: email,
      home_bay_id: account.home_bay_id,
      intent_id: opts.intent_id,
      origin: opts.origin,
    }),
    "password",
    new Date(),
  );
}

export async function beginFundingApprovalEmail(opts: {
  email_address: string;
  browser_binding: string;
  intent_id: string;
  origin: string;
}): Promise<FundingApprovalPendingAuth> {
  const { account, email } = await accountForEmail(opts.email_address);
  const challenge = await startEmailAuthChallengeDirect({
    email_address: email,
    browser_binding: opts.browser_binding,
    expected_account_id: account.account_id,
    purpose: "email_fresh_auth",
    code_only: true,
  });
  return pending({
    account_id: account.account_id,
    email_address: email,
    home_bay_id: account.home_bay_id,
    intent_id: opts.intent_id,
    origin: opts.origin,
    email_challenge_id: challenge.challenge_id,
  });
}

export async function getFundingApprovalEmailStatus(opts: {
  auth: FundingApprovalPendingAuth;
  browser_binding: string;
}) {
  requirePending(opts.auth);
  if (!opts.auth.email_challenge_id) {
    throw new Error("Email sign-in required");
  }
  return await getEmailAuthChallengeStatusDirect({
    challenge_id: opts.auth.email_challenge_id,
    browser_binding: opts.browser_binding,
  });
}

export async function completeFundingApprovalEmail(opts: {
  auth: FundingApprovalPendingAuth;
  code?: string;
}): Promise<FundingApprovalPendingAuth | FundingApprovalReadyAuth> {
  requirePending(opts.auth);
  const challenge_id = opts.auth.email_challenge_id;
  if (!challenge_id) throw new Error("Email sign-in required");
  if (opts.code != null) {
    await redeemEmailAuthCodeDirect({ challenge_id, code: opts.code });
  }
  const completed = await completeEmailFreshAuthDirect({
    account_id: opts.auth.account_id,
    challenge_id,
  });
  return await beginSecondFactor(
    opts.auth,
    completed.auth_method,
    new Date(completed.email_proved_at),
  );
}

export async function verifyFundingApprovalCode(opts: {
  auth: FundingApprovalPendingAuth;
  method: "totp" | "recovery_code";
  code: string;
}): Promise<FundingApprovalReadyAuth> {
  requirePending(opts.auth);
  if (!opts.auth.second_factor_challenge_id) {
    throw new Error("Second factor required");
  }
  const result = await homeAuth(opts.auth.home_bay_id, {
    action: "verify-code",
    account_id: opts.auth.account_id,
    approval_origin: opts.auth.origin,
    intent_id: opts.auth.intent_id,
    challenge_id: opts.auth.second_factor_challenge_id,
    method: opts.method,
    code: opts.code,
  });
  if (result.state !== "ready") throw new Error("Financial sign-in failed");
  return result;
}

export async function startFundingApprovalPasskey(opts: {
  auth: FundingApprovalPendingAuth;
  relying_party: {
    origin: string;
    rp_id: string;
    rp_name: string;
    allow_related_origin?: boolean;
  };
}) {
  requirePending(opts.auth);
  if (!opts.auth.second_factor_challenge_id) {
    throw new Error("Second factor required");
  }
  const result = await homeAuth(opts.auth.home_bay_id, {
    action: "start-passkey",
    account_id: opts.auth.account_id,
    approval_origin: opts.auth.origin,
    intent_id: opts.auth.intent_id,
    challenge_id: opts.auth.second_factor_challenge_id,
    relying_party: opts.relying_party,
  });
  if (result.state !== "passkey") throw new Error("Passkey unavailable");
  return result;
}

export async function finishFundingApprovalPasskey(opts: {
  auth: FundingApprovalPendingAuth;
  response: Record<string, unknown>;
}): Promise<FundingApprovalReadyAuth> {
  requirePending(opts.auth);
  if (!opts.auth.second_factor_challenge_id) {
    throw new Error("Second factor required");
  }
  const result = await homeAuth(opts.auth.home_bay_id, {
    action: "finish-passkey",
    account_id: opts.auth.account_id,
    approval_origin: opts.auth.origin,
    intent_id: opts.auth.intent_id,
    challenge_id: opts.auth.second_factor_challenge_id,
    response: opts.response,
  });
  if (result.state !== "ready") throw new Error("Financial sign-in failed");
  return result;
}

export async function issueFundingApprovalSession(opts: {
  auth: FundingApprovalReadyAuth;
  intent_id: string;
  origin: string;
}) {
  const token = randomBytes(32).toString("hex");
  const expire = new Date(Date.now() + 8 * 60 * 60_000);
  await getPool().query(
    `INSERT INTO financial_approval_sessions
       (session_hash,account_id,approval_origin,primary_auth_method,
        primary_verified_at,factor_level,factor_verified_at,
        authenticated_for_intent_id,expire)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      fundingSessionHash(token),
      opts.auth.account_id,
      opts.origin,
      opts.auth.primary_auth_method,
      new Date(opts.auth.primary_verified_at),
      opts.auth.factor_level,
      opts.auth.factor_verified_at
        ? new Date(opts.auth.factor_verified_at)
        : null,
      opts.intent_id,
      expire,
    ],
  );
  return { account_id: opts.auth.account_id, token };
}

export async function requireFundingApprovalSession(opts: {
  session_hash: string;
  payer_account_id?: string;
  intent_id: string;
  origin: string;
  db?: Pick<PoolClient, "query">;
}) {
  const db = opts.db ?? getPool();
  const session = (
    await db.query<FundingApprovalSessionRow>(
      `SELECT * FROM financial_approval_sessions WHERE session_hash=$1
         AND revoked_at IS NULL AND expire > clock_timestamp()
         ${opts.db ? "FOR SHARE" : ""}`,
      [opts.session_hash],
    )
  ).rows[0];
  if (
    !session ||
    (opts.payer_account_id != null &&
      session.account_id !== opts.payer_account_id) ||
    session.approval_origin !== opts.origin
  ) {
    throw new Error("Financial sign-in required");
  }
  return session.account_id;
}
