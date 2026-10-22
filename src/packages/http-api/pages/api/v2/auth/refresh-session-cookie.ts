/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The browser calls this while it uses a session, so its sign-in cookie never
// ends before the session does (see refreshSignInCookies).

import isPost from "@cocalc/http-api/lib/api/is-post";
import { refreshSignInCookies } from "@cocalc/server/auth/set-sign-in-cookies";

export default async function refreshSessionCookieApi(req, res) {
  if (!isPost(req, res)) {
    return;
  }
  try {
    res.json(await refreshSignInCookies({ req, res }));
  } catch (err) {
    res.json({
      error:
        err instanceof Error
          ? err.message
          : "Problem refreshing the sign-in cookie.",
    });
  }
}
