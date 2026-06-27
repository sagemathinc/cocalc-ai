/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";
import isPost from "@cocalc/http-api/lib/api/is-post";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { requireFreshAuth } from "@cocalc/server/auth/auth-sessions";
import { issueHomeBayRetryToken } from "@cocalc/server/auth/home-bay-retry-token";
import { getRememberMeHash } from "@cocalc/server/auth/remember-me";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";

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
    await requireFreshAuth({ req, account_id });
    const { challenge_id } = getParams(req);
    const cleanedChallengeId = `${challenge_id ?? ""}`.trim();
    if (!cleanedChallengeId) {
      throw new Error("challenge_id is required");
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
      home_bay_id,
      purpose: "cli-login",
      ttl_seconds: 5 * 60,
    });
    res.json({
      token: issued.token,
      expires_at: issued.expires_at,
      account_id,
      home_bay_id,
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
