/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { previewEmailProjectInvite } from "@cocalc/server/conat/api/projects";

export default async function handle(req, res) {
  try {
    if (req.header("Authorization")) {
      throw new Error("API keys are not allowed to use project invite links");
    }
    const account_id = await getAccountId(req);
    const { invite_id, project_id, token } = getParams(req);
    if (!token) {
      throw new Error("project invite link is incomplete");
    }
    const invite = await previewEmailProjectInvite({
      account_id,
      ...(project_id ? { project_id } : {}),
      ...(invite_id ? { invite_id } : {}),
      token,
    });
    res.json({ invite });
  } catch (err) {
    res.json({ error: `${(err as Error).message ?? err}` });
  }
}
