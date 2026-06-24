/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Request, Response, Router } from "express";

import basePath from "@cocalc/backend/base-path";
import { sendPublicAppShell } from "./public-shell";

function publicShellRedirectPath(target: string): string {
  const base = basePath === "/" ? "" : basePath.replace(/\/+$/, "");
  return `${base}/static/public.html?target=${encodeURIComponent(target)}`;
}

function redirectToPublicShell(req: Request, res: Response): void {
  res.redirect(302, publicShellRedirectPath(req.originalUrl || req.url));
}

export default function initPublicFeatures(router: Router): void {
  const featurePaths = [
    "/features",
    "/features/",
    "/features/:slug",
    "/features/:slug/",
    /^\/docs(?:\/.*)?$/,
  ];
  const rootfsPaths = [
    "/rootfs",
    "/rootfs/",
    "/rootfs/id/:imageId",
    "/rootfs/id/:imageId/",
    "/rootfs/:slug",
    "/rootfs/:slug/",
  ];

  router.get(featurePaths, sendPublicAppShell);
  router.get(rootfsPaths, redirectToPublicShell);
}
