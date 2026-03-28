/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Request, Response, Router } from "express";

import basePath from "@cocalc/backend/base-path";
import { getLegacyCommerceTargetPath } from "@cocalc/util/routing/legacy-commerce";
import { joinUrlPath } from "@cocalc/util/url-path";

function redirectToCanonicalRoute(req: Request, res: Response): void {
  const target = getLegacyCommerceTargetPath(req.path);
  if (!target) {
    res.status(404).end();
    return;
  }
  const search = req.url.includes("?")
    ? req.url.slice(req.url.indexOf("?"))
    : "";
  res.redirect(307, joinUrlPath(basePath, target) + search);
}

export default function init(router: Router): void {
  router.get(/^\/billing(?:\/.*)?$/, redirectToCanonicalRoute);
  router.get(/^\/store(?:\/.*)?$/, redirectToCanonicalRoute);
}
