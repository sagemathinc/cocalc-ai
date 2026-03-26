/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { join } from "path";
import type { Router } from "express";
import basePath from "@cocalc/backend/base-path";

export default function initPublicAuth(router: Router): void {
  const authPaths = [
    "/auth",
    "/auth/",
    "/auth/sign-in",
    "/auth/sign-in/*",
    "/auth/sign-up",
    "/auth/sign-up/*",
    "/auth/password-reset",
    "/auth/password-reset/*",
    "/auth/password-reset-done",
    "/auth/password-reset-done/*",
    "/auth/verify",
    "/auth/verify/*",
    "/sso",
    "/sso/*",
  ];

  router.get(authPaths, (req, res) => {
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
    res.redirect(join(basePath, "static/public-auth.html") + url.search);
  });
}
