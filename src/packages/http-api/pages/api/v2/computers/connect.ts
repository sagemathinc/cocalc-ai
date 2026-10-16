/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A paired computer asks where to connect: its project's host, and a short
// host token. Authenticated by the computer's token; see
// server/computers/pairing-http.ts.

import getParams from "@cocalc/http-api/lib/api/get-params";
import isPost from "@cocalc/http-api/lib/api/is-post";
import {
  computerConnect,
  requestAddress,
} from "@cocalc/server/computers/pairing-http";

export default async function handle(req, res) {
  if (!isPost(req, res)) {
    return;
  }
  const { computer_id, token } = getParams(req);
  res.json(await computerConnect({ computer_id, token }, requestAddress(req)));
}
