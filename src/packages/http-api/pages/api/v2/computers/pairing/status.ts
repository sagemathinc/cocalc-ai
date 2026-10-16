/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The claiming machine polls for the owner's decision, with the secret its
// claim returned. Unauthenticated otherwise: see server/computers/pairing-http.ts.

import getParams from "@cocalc/http-api/lib/api/get-params";
import isPost from "@cocalc/http-api/lib/api/is-post";
import {
  pairingStatus,
  requestAddress,
} from "@cocalc/server/computers/pairing-http";

export default async function handle(req, res) {
  if (!isPost(req, res)) {
    return;
  }
  const { request_id, secret } = getParams(req);
  res.json(await pairingStatus({ request_id, secret }, requestAddress(req)));
}
