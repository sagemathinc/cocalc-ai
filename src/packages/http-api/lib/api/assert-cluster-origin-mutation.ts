/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { isAllowedBrowserOrigin } from "@cocalc/server/bay-public-origin";

/** For cookie-authenticated browser mutations that a page on another bay of
 * this site calls cross-origin (e.g. on the user's home bay): require a JSON
 * body, which a cross-site page can only send after a CORS preflight, and an
 * Origin of this site or one of its bays. */
export default async function assertClusterOriginMutation(req): Promise<void> {
  const contentType = `${req.header?.("content-type") ?? ""}`.toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new Error("a JSON browser request is required");
  }
  if (!(await isAllowedBrowserOrigin(req.header?.("origin"), req))) {
    throw new Error("browser request from this site required");
  }
}
