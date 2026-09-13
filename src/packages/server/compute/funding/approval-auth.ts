/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { createHash, randomBytes } from "node:crypto";
import { verifyLocalSignInPassword } from "@cocalc/server/auth/verify-sign-in-password";
import { verifyFreshAuthCredentials } from "@cocalc/server/auth/two-factor";
import {
  getAuthSession,
  recordNewAuthSession,
  requireFreshAuthForSessionHash,
} from "@cocalc/server/auth/auth-sessions";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import type { PoolClient } from "@cocalc/database/pool";
import type { AccountAuthSessionRow } from "@cocalc/server/auth/auth-sessions";

export function fundingSessionHash(token: string): string {
  if (!/^[a-f0-9]{64}$/.test(token))
    throw new Error("Financial sign-in required");
  return createHash("sha256").update(token).digest("hex");
}

export async function signInFundingApprover(opts: {
  email_address: string;
  password: string;
  method?: string;
  code?: string;
  intent_id: string;
  origin: string;
}) {
  const { account_id } = await verifyLocalSignInPassword({
    email_address: opts.email_address,
    password: opts.password,
  });
  const account = await getClusterAccountById(account_id);
  if (account?.home_bay_id !== getConfiguredBayId()) {
    throw new Error("Financial sign-in requires the account home bay");
  }
  const factor_level = await verifyFreshAuthCredentials({
    account_id,
    current_password: opts.password,
    method: opts.method,
    code: opts.code,
  });
  const token = randomBytes(32).toString("hex");
  const now = new Date();
  const expire = new Date(now.valueOf() + 15 * 60_000);
  // No remember_me row: this token must not become a general account session.
  await recordNewAuthSession({
    account_id,
    session_hash: fundingSessionHash(token),
    expire,
    authenticated_at: now,
    password_verified_at: now,
    factor_verified_at: factor_level === "none" ? null : now,
    factor_level,
    fresh_auth_until: expire,
    metadata: {
      financial_approval_origin: opts.origin,
      financial_intent_id: opts.intent_id,
    },
  });
  return { account_id, token };
}

export async function requireFundingApprovalSession(opts: {
  session_hash: string;
  payer_account_id?: string;
  intent_id: string;
  origin: string;
  db?: Pick<PoolClient, "query">;
}) {
  const session = opts.db
    ? (
        await opts.db.query<AccountAuthSessionRow>(
          `SELECT * FROM account_auth_sessions WHERE session_hash=$1
         AND revoked_at IS NULL AND expire > clock_timestamp()
         AND fresh_auth_until > clock_timestamp() FOR SHARE`,
          [opts.session_hash],
        )
      ).rows[0]
    : await getAuthSession(opts.session_hash);
  if (
    !session ||
    (opts.payer_account_id != null &&
      session.account_id !== opts.payer_account_id) ||
    session.metadata?.financial_approval_origin !== opts.origin ||
    session.metadata?.financial_intent_id !== opts.intent_id
  )
    throw new Error("Financial sign-in required");
  if (!opts.db) {
    await requireFreshAuthForSessionHash({
      account_id: session.account_id,
      session_hash: opts.session_hash,
      allow_actor_impersonation: false,
    });
  }
  return session.account_id;
}
