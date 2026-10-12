/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A connected computer's single-use login challenge. Unauthenticated and
// grants nothing by itself: the login must be signed by the computer's key.
// See server/computers/sessions.ts.

import getParams from "@cocalc/http-api/lib/api/get-params";
import isPost from "@cocalc/http-api/lib/api/is-post";
import {
  requestAddress,
  sessionChallenge,
} from "@cocalc/server/computers/pairing-http";

export default async function handle(req, res) {
  if (!isPost(req, res)) {
    return;
  }
  const { computer_id } = getParams(req);
  res.json(await sessionChallenge({ computer_id }, requestAddress(req)));
}
