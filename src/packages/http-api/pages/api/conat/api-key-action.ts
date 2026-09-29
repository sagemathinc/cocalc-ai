/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { getAccountFromApiKey } from "@cocalc/server/auth/api";
import { requireApiKeyCapability } from "@cocalc/server/api/api-key-scope";
import { requestApiKeyAction } from "@cocalc/server/api/key-action-routing";
import { normalizeApiKeyActionRequest } from "@cocalc/util/api-key-management";

export default async function handle(req, res) {
  try {
    if (req.method !== "POST") throw new Error("POST required");
    const principal = await getAccountFromApiKey(req);
    if (principal?.auth_method !== "api_key")
      throw new Error("account API key authentication required");
    requireApiKeyCapability(principal, "api-key:revoke:request");
    const request = normalizeApiKeyActionRequest(req.body);
    res.json(await requestApiKeyAction(principal, request));
  } catch (err) {
    res.json({ error: err instanceof Error ? err.message : "request failed" });
  }
}
