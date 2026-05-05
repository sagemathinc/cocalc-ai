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
    "/auth/sign-in/*rest",
    "/auth/sign-up",
    "/auth/sign-up/*rest",
    "/auth/password-reset",
    "/auth/password-reset/*rest",
    "/auth/password-reset-done",
    "/auth/password-reset-done/*rest",
    "/auth/verify",
    "/auth/verify/*rest",
    "/redeem",
    "/redeem/*rest",
    "/sso",
    "/sso/*rest",
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
    res.redirect(join(basePath, "static/public.html") + url.search);
  });
}
