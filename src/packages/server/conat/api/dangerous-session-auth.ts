/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { AccountAuthSessionRow } from "@cocalc/server/auth/auth-sessions";
import { requireFreshAuthForSessionHash } from "@cocalc/server/auth/auth-sessions";
import { getBrowserAuthSessionHash } from "@cocalc/server/conat/socketio/browser-auth-sessions";
import {
  getImpersonationSessionBySessionHash,
  type ImpersonationSessionRow,
} from "@cocalc/server/auth/impersonation";
import { hasActiveSecondFactor } from "@cocalc/server/auth/two-factor";

function freshAuthRequired(message = "fresh auth is required"): Error {
  return Object.assign(new Error(message), {
    code: "fresh_auth_required",
  });
}

function twoFactorRequired(message: string): Error {
  return Object.assign(new Error(message), {
    code: "two_factor_required",
  });
}

function isAtLeastAsRecent({
  verified_at,
  password_verified_at,
}: {
  verified_at?: Date | null;
  password_verified_at?: Date | null;
}): boolean {
  if (!verified_at) {
    return false;
  }
  if (!password_verified_at) {
    return true;
  }
  return (
    new Date(verified_at).valueOf() >=
    new Date(password_verified_at).valueOf() - 1000
  );
}

function isDevCliFreshAuth(session: AccountAuthSessionRow): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    session.metadata?.dev_cli_fresh_auth === true
  );
}

function hasRecentSecondFactor(session: AccountAuthSessionRow): boolean {
  if (isDevCliFreshAuth(session)) {
    return true;
  }
  return (
    (session.factor_level ?? "none") !== "none" &&
    isAtLeastAsRecent({
      verified_at: session.factor_verified_at,
      password_verified_at: session.password_verified_at,
    })
  );
}

function impersonationHasRecentSecondFactor(
  session: ImpersonationSessionRow,
): boolean {
  return (
    (session.actor_factor_level ?? "none") !== "none" &&
    isAtLeastAsRecent({
      verified_at: session.actor_factor_verified_at,
      password_verified_at: session.actor_password_verified_at,
    })
  );
}

export async function requireDangerousSessionAuth({
  account_id,
  browser_id,
  session_hash,
  require_second_factor = false,
}: {
  account_id?: string | null;
  browser_id?: string | null;
  session_hash?: string | null;
  require_second_factor?: boolean;
}): Promise<AccountAuthSessionRow> {
  const accountId = `${account_id ?? ""}`.trim();
  if (!accountId) {
    throw new Error("must be signed in");
  }
  const sessionHash =
    `${session_hash ?? ""}`.trim() ||
    getBrowserAuthSessionHash({
      account_id: accountId,
      browser_id: `${browser_id ?? ""}`.trim(),
    });
  if (!sessionHash) {
    throw freshAuthRequired();
  }

  const session = await requireFreshAuthForSessionHash({
    account_id: accountId,
    session_hash: sessionHash,
    allow_actor_impersonation: true,
  });

  if (!require_second_factor) {
    return session;
  }

  const impersonation = await getImpersonationSessionBySessionHash({
    session_hash: sessionHash,
    subject_account_id: accountId,
  });
  if (impersonation) {
    if (!(await hasActiveSecondFactor(impersonation.actor_account_id))) {
      throw twoFactorRequired(
        "actor must enable two-factor authentication for this operation",
      );
    }
    if (!impersonationHasRecentSecondFactor(impersonation)) {
      throw freshAuthRequired(
        "recent actor two-factor verification is required",
      );
    }
    return session;
  }

  if (!(await hasActiveSecondFactor(accountId))) {
    if (!isDevCliFreshAuth(session)) {
      throw twoFactorRequired(
        "two-factor authentication is required for this operation",
      );
    }
  }
  if (!hasRecentSecondFactor(session)) {
    throw freshAuthRequired("recent two-factor verification is required");
  }
  return session;
}
