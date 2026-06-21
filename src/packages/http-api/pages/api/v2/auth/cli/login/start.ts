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
    const { email } = getParams(req);
    res.json(
      await startCliLoginChallenge({
        req,
        email: `${email ?? ""}`.trim() || undefined,
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
