/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getParams from "@cocalc/http-api/lib/api/get-params";
import isPost from "@cocalc/http-api/lib/api/is-post";
import { startCliLoginChallenge } from "@cocalc/server/auth/cli-auth";

export default async function cliLoginStart(req, res) {
  if (!isPost(req, res)) {
    return;
  }

  try {
    const { email, elevated_login, duration, client_kind } = getParams(req);
    const elevatedLogin = elevated_login === true || elevated_login === "true";
    const requestedDuration = duration === "extended" ? "extended" : "default";
    res.json(
      await startCliLoginChallenge({
        req,
        email: `${email ?? ""}`.trim() || undefined,
        client_kind: client_kind === "mobile" ? "mobile" : "cli",
        elevated_login: elevatedLogin,
        duration: elevatedLogin ? requestedDuration : undefined,
      }),
    );
  } catch (err) {
    res.json({
      error:
        err instanceof Error
          ? err.message
          : "Problem starting CLI login challenge.",
    });
  }
}
