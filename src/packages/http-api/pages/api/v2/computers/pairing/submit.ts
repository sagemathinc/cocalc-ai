/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The machine claims a computer request with its signed pairing transcript.
// Unauthenticated and grants nothing: the owner approves in CoCalc with fresh
// auth. See server/computers/pairing-http.ts.

import getParams from "@cocalc/http-api/lib/api/get-params";
import isPost from "@cocalc/http-api/lib/api/is-post";
import {
  pairingSubmit,
  requestAddress,
} from "@cocalc/server/computers/pairing-http";

export default async function handle(req, res) {
  if (!isPost(req, res)) {
    return;
  }
  const { request_id, transcript, signing_public_key, resolved_policy } =
    getParams(req);
  res.json(
    await pairingSubmit(
      { request_id, transcript, signing_public_key, resolved_policy },
      requestAddress(req),
    ),
  );
}
