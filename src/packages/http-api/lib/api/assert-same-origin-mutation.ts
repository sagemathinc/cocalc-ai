/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  detectRequestOrigin,
  normalizeOrigin,
} from "@cocalc/server/bay-public-origin";

export default function assertSameOriginMutation(req): void {
  const fetchSite = `${req.header?.("sec-fetch-site") ?? ""}`.toLowerCase();
  if (fetchSite && fetchSite !== "same-origin")
    throw new Error("same-origin browser request required");
  const supplied = normalizeOrigin(req.header?.("origin"));
  const expected = detectRequestOrigin(req);
  if (!supplied || !expected || supplied !== expected)
    throw new Error("same-origin browser request required");
}
