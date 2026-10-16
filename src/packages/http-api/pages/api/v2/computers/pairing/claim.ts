/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The machine claims a computer request and gets its secret and pairing
// phrase. Unauthenticated and grants nothing: the owner approves in CoCalc
// with fresh auth. See server/computers/pairing-http.ts.

import getParams from "@cocalc/http-api/lib/api/get-params";
import isPost from "@cocalc/http-api/lib/api/is-post";
import {
  pairingClaim,
  requestAddress,
} from "@cocalc/server/computers/pairing-http";

export default async function handle(req, res) {
  if (!isPost(req, res)) {
    return;
  }
  const { request_id, machine } = getParams(req);
  res.json(await pairingClaim({ request_id, machine }, requestAddress(req)));
}
