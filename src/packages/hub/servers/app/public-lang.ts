/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Request, Response, Router } from "express";

import basePath from "@cocalc/backend/base-path";
import { LOCALE } from "@cocalc/util/i18n";
import { joinUrlPath } from "@cocalc/util/url-path";

function getSearch(req: Request): string {
  return req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
}

function redirectToStatic(req: Request, res: Response): void {
  const targetPath = joinUrlPath(basePath, req.path);
  const url = new URL("http://host");
  const search = getSearch(req);
  if (search) {
    url.searchParams.set("target", targetPath + search);
  } else {
    url.searchParams.set("target", targetPath);
  }
  res.redirect(joinUrlPath(basePath, "static/public-lang.html") + url.search);
}

export default function initPublicLang(router: Router): void {
  router.get(["/lang", "/lang/"], redirectToStatic);

  router.get(["/lang/:locale", "/lang/:locale/"], (req, res) => {
    const locale = `${req.params.locale ?? ""}`;
    if (!LOCALE.includes(locale as any)) {
      res.status(404).end();
      return;
    }
    res.redirect(joinUrlPath(basePath, locale) + getSearch(req));
  });

  router.get(
    LOCALE.flatMap((locale) => [`/${locale}`, `/${locale}/`]),
    redirectToStatic,
  );
}
