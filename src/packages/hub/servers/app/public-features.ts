/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { join } from "path";
import type { Router } from "express";

import basePath from "@cocalc/backend/base-path";

export default function initPublicFeatures(router: Router): void {
  const featurePaths = [
    "/features",
    "/features/",
    "/features/:slug",
    "/features/:slug/",
  ];

  router.get(featurePaths, (req, res) => {
    const targetPath = join(basePath, req.path);
    const url = new URL("http://host");
    const search = req.url.includes("?")
      ? req.url.slice(req.url.indexOf("?"))
      : "";
    if (search) {
      url.searchParams.set("target", targetPath + search);
    } else {
      url.searchParams.set("target", targetPath);
    }
    res.redirect(join(basePath, "static/public.html") + url.search);
  });
}
