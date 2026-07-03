/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Request, Response } from "express";

import basePath from "@cocalc/backend/base-path";
import { getLogger } from "@cocalc/hub/logger";
import { PUBLIC_SITEMAP_PATHS } from "@cocalc/util/public-site-metadata";
import { joinUrlPath } from "@cocalc/util/url-path";

export { PUBLIC_SITEMAP_PATHS } from "@cocalc/util/public-site-metadata";

const logger = getLogger("hub:servers:sitemap");

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function requestOrigin(req: Request): string {
  return `${req.protocol}://${req.get("host")}`;
}

export function sitemapLocation(req: Request, path: string): string {
  return `${requestOrigin(req)}${joinUrlPath(basePath, path)}`;
}

export function renderSitemapXml(req: Request): string {
  const urls = PUBLIC_SITEMAP_PATHS.map((path) => {
    return `  <url><loc>${xmlEscape(sitemapLocation(req, path))}</loc></url>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
}

export default function getHandler() {
  return (req: Request, res: Response) => {
    try {
      res.header("Content-Type", "application/xml; charset=utf-8");
      res.header("Cache-Control", "public, max-age=3600, must-revalidate");
      res.send(renderSitemapXml(req));
    } catch (err) {
      logger.warn("sitemap endpoint failed", { err: `${err}` });
      res.status(500).type("text/plain").send("internal error");
    }
  };
}
