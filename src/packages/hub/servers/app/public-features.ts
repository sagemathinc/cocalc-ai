/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Router } from "express";

import { sendPublicAppShell } from "./public-shell";

export default function initPublicFeatures(router: Router): void {
  const featurePaths = [
    "/features",
    "/features/",
    "/features/:slug",
    "/features/:slug/",
    /^\/docs(?:\/.*)?$/,
  ];

  router.get(featurePaths, sendPublicAppShell);
}
