/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Router } from "express";

import { sendPublicAppShell } from "./public-shell";

export default function initPublicSupport(router: Router): void {
  const supportPaths = [
    "/support",
    "/support/",
    "/support/community",
    "/support/community/",
    "/support/new",
    "/support/new/*rest",
    "/support/tickets",
    "/support/tickets/*rest",
  ];

  router.get(supportPaths, sendPublicAppShell);
}
