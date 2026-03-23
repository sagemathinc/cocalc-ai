/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { join } from "path";
import type { Router } from "express";

import basePath from "@cocalc/backend/base-path";

export default function initPublicContent(router: Router): void {
  const contentPaths = [
    "/about",
    "/about/",
    "/policies",
    "/policies/",
    "/news",
    "/news/",
  ];

  router.get(contentPaths, (req, res) => {
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
    res.redirect(join(basePath, "static/public-content.html") + url.search);
  });
}
