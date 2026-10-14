/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The claimant polls for the owner's decision; once approved, its certificate.
// Unauthenticated and grants nothing: the owner approves in CoCalc with fresh
// auth. See server/computers/pairing-http.ts.

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
  const { request_id, transcript_hash } = getParams(req);
  res.json(
    await pairingStatus({ request_id, transcript_hash }, requestAddress(req)),
  );
}
