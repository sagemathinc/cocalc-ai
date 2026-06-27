/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";
import isPost from "@cocalc/http-api/lib/api/is-post";
import { getRememberMeHash } from "@cocalc/server/auth/remember-me";
import { approveCliLoginChallenge } from "@cocalc/server/auth/cli-auth";
import { requireFreshAuth } from "@cocalc/server/auth/auth-sessions";
import { verifyHomeBayRetryToken } from "@cocalc/server/auth/home-bay-retry-token";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";

export default async function cliLoginApprove(req, res) {
  if (!isPost(req, res)) {
    return;
  }

  try {
    const { challenge_id } = getParams(req);
    const cleanedChallengeId = `${challenge_id ?? ""}`.trim();
    const account_id = await getApprovingAccountId({
      req,
      challenge_id: cleanedChallengeId,
    });
    res.json(
      await approveCliLoginChallenge({
        challenge_id: cleanedChallengeId,
        account_id,
      }),
    );
  } catch (err) {
    res.json({
      error:
        err instanceof Error
          ? err.message
          : "Problem approving CLI login challenge.",
      ...((err as any)?.code != null ? { code: (err as any).code } : {}),
    });
  }
}

async function getApprovingAccountId({
  req,
  challenge_id,
}: {
  req;
  challenge_id: string;
}): Promise<string> {
  const { approval_token, approval_home_bay_id } = getParams(req);
  const token = `${approval_token ?? ""}`.trim();
  if (token) {
    const home_bay_id = `${approval_home_bay_id ?? ""}`.trim();
    const claims = verifyHomeBayRetryToken({
      token,
      home_bay_id,
      challenge_id,
      purpose: "cli-login",
    });
    const account_id = `${claims.account_id ?? ""}`.trim();
    if (!account_id) {
      throw new Error("CLI login approval token is missing account_id");
    }
    const account = await getClusterAccountById(account_id);
    if (`${account?.home_bay_id ?? ""}`.trim() !== claims.home_bay_id) {
      throw new Error("CLI login approval token account home bay mismatch");
    }
    return account_id;
  }

  const account_id = await getAccountId(req);
  if (!account_id || !getRememberMeHash(req)) {
    throw new Error("must be signed in");
  }
  await requireFreshAuth({ req, account_id });
  return account_id;
}
