/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The sign-in sessions (browsers and CLIs) of the signed-in account whose fresh
auth is still active, with when each one ends. Account Settings > Profile >
Security shows them with a countdown and an "End now" button.
*/

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import isPost from "@cocalc/http-api/lib/api/is-post";
import { listActiveFreshAuthSessions } from "@cocalc/server/auth/auth-sessions";
import { getRememberMeHash } from "@cocalc/server/auth/remember-me";

export default async function freshAuthSessionsApi(req, res) {
  if (!isPost(req, res)) {
    return;
  }

  try {
    const account_id = await getAccountId(req);
    if (!account_id) {
      throw new Error("must be signed in");
    }
    const current_session_hash = getRememberMeHash(req);
    if (!current_session_hash) {
      throw new Error("browser sign-in is required");
    }
    res.json({
      sessions: await listActiveFreshAuthSessions({
        account_id,
        current_session_hash,
      }),
    });
  } catch (err) {
    res.json({
      error:
        err instanceof Error
          ? err.message
          : "Problem loading the active fresh auth sessions.",
    });
  }
}
