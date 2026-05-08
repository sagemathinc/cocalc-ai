/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getParams from "@cocalc/http-api/lib/api/get-params";
import { getCliAuthApprovalInfo } from "@cocalc/server/auth/cli-auth";
import getAccountId from "@cocalc/server/auth/get-account";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";

export default async function cliChallengeInfo(req, res) {
  try {
    const { challenge_id } = getParams(req);
    const info = await getCliAuthApprovalInfo({
      challenge_id: `${challenge_id ?? ""}`,
    });
    const current_account_id = await getAccountId(req);
    const current =
      current_account_id != null
        ? await getClusterAccountById(current_account_id)
        : null;
    const current_display_name =
      `${current?.first_name ?? ""} ${current?.last_name ?? ""}`.trim() || null;
    res.json({
      ...info,
      current_account_id: current_account_id ?? null,
      current_email_address: current?.email_address ?? null,
      current_display_name,
      current_matches_account:
        current_account_id == null
          ? null
          : current_account_id === info.account_id,
    });
  } catch (err) {
    res.json({
      error:
        err instanceof Error
          ? err.message
          : "Problem loading CLI auth challenge.",
    });
  }
}
