/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
End the fresh auth of one sign-in session ({ id } from auth/fresh-auth-sessions),
of this session ({ current: true }), or of all of them ({ all: true }). The
sessions stay signed in. Ending takes a privilege away, so it needs no fresh
auth itself.
*/

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";
import isPost from "@cocalc/http-api/lib/api/is-post";
import { endFreshAuth } from "@cocalc/server/auth/auth-sessions";
import { getRememberMeHash } from "@cocalc/server/auth/remember-me";

export default async function endFreshAuthApi(req, res) {
  if (!isPost(req, res)) {
    return;
  }

  try {
    const account_id = await getAccountId(req);
    if (!account_id) {
      throw new Error("must be signed in");
    }
    const session_hash = getRememberMeHash(req);
    if (!session_hash) {
      throw new Error("browser sign-in is required");
    }
    const { id, current, all } = getParams(req);
    const endAll = all === true || all === "true";
    const endCurrent = current === true || current === "true";
    res.json(
      await endFreshAuth({
        account_id,
        all: endAll,
        ...(endAll
          ? {}
          : endCurrent
            ? { session_hash }
            : { id: `${id ?? ""}` }),
      }),
    );
  } catch (err) {
    res.json({
      error: err instanceof Error ? err.message : "Problem ending fresh auth.",
    });
  }
}
