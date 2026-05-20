/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ProjectCollabInviteAction } from "@cocalc/conat/hub/api/projects";
import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { respondEmailProjectInvite } from "@cocalc/server/conat/api/projects";

const ACTIONS = new Set(["accept", "decline", "block"]);

export default async function handle(req, res) {
  try {
    const account_id = await getAccountId(req);
    if (!account_id) {
      throw new Error("must be signed in to respond to a project invite");
    }
    const { action, invite_id, project_id, token } = getParams(req);
    if (!token) {
      throw new Error("project invite link is incomplete");
    }
    if (!ACTIONS.has(action)) {
      throw new Error("invalid project invite action");
    }
    const invite = await respondEmailProjectInvite({
      account_id,
      action: action as ProjectCollabInviteAction,
      ...(project_id ? { project_id } : {}),
      ...(invite_id ? { invite_id } : {}),
      token,
    });
    res.json({ invite });
  } catch (err) {
    res.json({ error: `${(err as Error).message ?? err}` });
  }
}
