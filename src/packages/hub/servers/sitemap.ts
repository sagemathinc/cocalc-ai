import { get_server_settings } from "@cocalc/database/postgres/settings/server-settings";
import { getLogger } from "@cocalc/hub/logger";
import { PUBLIC_SITEMAP_PATHS } from "@cocalc/util/public-site-metadata";
import type { Request } from "express";
import { publicOrigin } from "./public-origin";

const logger = getLogger("hub:servers:sitemap");

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) => {
    switch (char) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case "'":
        return "&apos;";
      case '"':
        return "&quot;";
      default:
        return char;
    }
  });
}

function sitemapUrl(req: Request, path: string): string {
  return escapeXml(new URL(path, publicOrigin(req)).href);
}

export function sitemapXml(req: Request): string {
  const urls = PUBLIC_SITEMAP_PATHS.map(
    (path) => `  <url><loc>${sitemapUrl(req, path)}</loc></url>`,
  ).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

export default function getHandler() {
  return async (req, res) => {
    try {
      const settings = await get_server_settings(); // don't worry -- this is cached.
      if (!settings.landing_pages) {
        res.status(404).type("text/plain").send("not found");
        return;
      }
      res.header("Content-Type", "application/xml; charset=utf-8");
      res.header("Cache-Control", "public, max-age=3600, must-revalidate");
      res.send(sitemapXml(req));
    } catch (err) {
      logger.warn("sitemap endpoint failed", { err: `${err}` });
      res.status(500).type("text/plain").send("internal error");
    }
  };
}
