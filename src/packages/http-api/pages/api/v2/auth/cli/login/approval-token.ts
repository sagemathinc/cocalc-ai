/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";
import isPost from "@cocalc/http-api/lib/api/is-post";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  requireFreshAuth,
  resolveFreshAuthDurationMs,
  type FreshAuthDuration,
} from "@cocalc/server/auth/auth-sessions";
import { issueHomeBayRetryToken } from "@cocalc/server/auth/home-bay-retry-token";
import { getRememberMeHash } from "@cocalc/server/auth/remember-me";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";
import { parseFreshAuthDuration } from "@cocalc/util/auth/fresh-auth-duration";

export default async function cliLoginApprovalToken(req, res) {
  if (!isPost(req, res)) {
    return;
  }

  try {
    if (req.header("Authorization")) {
      throw new Error("API keys are not allowed to approve CLI login");
    }
    const account_id = await getAccountId(req);
    if (!account_id || !getRememberMeHash(req)) {
      throw new Error("must be signed in");
    }
    const session = await requireFreshAuth({ req, account_id });
    const { challenge_id, elevated_login, requested_duration } = getParams(req);
    const cleanedChallengeId = `${challenge_id ?? ""}`.trim();
    if (!cleanedChallengeId) {
      throw new Error("challenge_id is required");
    }
    const elevatedLogin = elevated_login === true || elevated_login === "true";
    const requestedDuration: FreshAuthDuration =
      parseFreshAuthDuration(requested_duration);
    const factor_level = session.factor_level ?? "none";
    const fresh_auth_until = session.fresh_auth_until
      ? new Date(session.fresh_auth_until)
      : null;
    if (fresh_auth_until == null) {
      throw Object.assign(new Error("fresh auth is required for cli login"), {
        code: "fresh_auth_required",
      });
    }
    if (elevatedLogin) {
      const requiredMs = resolveFreshAuthDurationMs({
        duration: requestedDuration,
        factor_level,
      });
      if (
        fresh_auth_until == null ||
        fresh_auth_until.valueOf() < Date.now() + requiredMs - 60_000
      ) {
        throw Object.assign(
          new Error("fresh auth is required for elevated cli login"),
          { code: "fresh_auth_required" },
        );
      }
    }
    const account = await getClusterAccountById(account_id);
    const home_bay_id =
      `${account?.home_bay_id ?? ""}`.trim() || getConfiguredBayId();
    if (home_bay_id !== getConfiguredBayId()) {
      throw new Error("CLI login approval token must be issued by home bay");
    }
    const issued = issueHomeBayRetryToken({
      account_id,
      challenge_id: cleanedChallengeId,
      factor_level,
      fresh_auth_until: fresh_auth_until.toISOString(),
      home_bay_id,
      purpose: "cli-login",
      ttl_seconds: 5 * 60,
    });
    res.json({
      token: issued.token,
      expires_at: issued.expires_at,
      account_id,
      home_bay_id,
      factor_level,
      fresh_auth_until: fresh_auth_until.toISOString(),
    });
  } catch (err) {
    res.json({
      error:
        err instanceof Error
          ? err.message
          : "Problem creating CLI login approval token.",
      ...((err as any)?.code != null ? { code: (err as any).code } : {}),
    });
  }
}
