/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// What a computer request asks for, so the machine can show it before pairing.
// Unauthenticated and grants nothing: the owner approves in CoCalc with fresh
// auth. See server/computers/pairing-http.ts.

import getParams from "@cocalc/http-api/lib/api/get-params";
import isPost from "@cocalc/http-api/lib/api/is-post";
import {
  pairingView,
  requestAddress,
} from "@cocalc/server/computers/pairing-http";

export default async function handle(req, res) {
  if (!isPost(req, res)) {
    return;
  }
  const { request_id } = getParams(req);
  res.json(await pairingView({ request_id }, requestAddress(req)));
}
