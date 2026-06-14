/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Request, Response } from "express";
import { existsSync, readFileSync, statSync } from "fs";
import ms from "ms";
import { join } from "path";

import basePath from "@cocalc/backend/base-path";
import getCustomize from "@cocalc/database/settings/customize";
import {
  getPublicMetadataRouteFromPath,
  getPublicRouteMetadata,
  type PublicRouteMetadata,
  type PublicRouteMetadataConfig,
} from "@cocalc/util/public-site-metadata";
import { path as STATIC_PATH } from "@cocalc/static";
import { joinUrlPath } from "@cocalc/util/url-path";
import { isLaunchpadMode } from "@cocalc/server/software-licenses/activation";

const SHORT_AGE = Math.round(ms("10 seconds") / 1000);
const FALLBACK_PUBLIC_HTML = `<!doctype html>
<html>
  <head>
    <title>CoCalc</title>
  </head>
  <body>
    <div id="cocalc-crash-container"></div>
    <div id="cocalc-load-container"></div>
    <div id="cocalc-scripts-container"></div>
    <div id="cocalc-webapp-container"></div>
  </body>
</html>`;

interface PublicShellCache {
  filename: string;
  html: string;
  mtimeMs: number;
}

let publicShellCache: PublicShellCache | undefined;

function cacheShortTerm(res: Response): void {
  res.setHeader(
    "Cache-Control",
    `public, max-age=${SHORT_AGE}, must-revalidate`,
  );
  res.setHeader(
    "Expires",
    new Date(Date.now().valueOf() + SHORT_AGE).toUTCString(),
  );
}

function getSearch(req: Request): string {
  return req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
}

function resolveStaticPath(): string {
  const candidates: string[] = [];
  if (process.env.COCALC_STATIC_PATH) {
    candidates.push(process.env.COCALC_STATIC_PATH);
  }
  if (process.env.COCALC_BUNDLE_DIR) {
    candidates.push(join(process.env.COCALC_BUNDLE_DIR, "static"));
  }
  candidates.push(
    STATIC_PATH,
    join(process.cwd(), "static"),
    join(__dirname, "..", "static"),
  );
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "public.html"))) {
      return candidate;
    }
  }
  return STATIC_PATH;
}

function readPublicShellTemplate(): string {
  const filename = join(resolveStaticPath(), "public.html");
  try {
    const stat = statSync(filename);
    if (
      publicShellCache?.filename === filename &&
      publicShellCache.mtimeMs === stat.mtimeMs
    ) {
      return publicShellCache.html;
    }
    const html = readFileSync(filename, "utf8");
    publicShellCache = { filename, html, mtimeMs: stat.mtimeMs };
    return html;
  } catch {
    return FALLBACK_PUBLIC_HTML;
  }
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function originFromRequest(req: Request): string {
  const forwardedProto = req.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProto || req.protocol;
  return `${protocol}://${req.get("host")}`;
}

function absoluteUrl(req: Request, path: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return path;
  return `${originFromRequest(req)}${path}`;
}

function prefixStaticAssetPaths(html: string): string {
  const staticBase = joinUrlPath(basePath, "static");
  return html.replace(
    /\b(src|href)="((?![a-z][a-z0-9+.-]*:|\/|#)[^"]+)"/gi,
    (_match, attr: string, value: string) => `${attr}="${staticBase}/${value}"`,
  );
}

function metadataTags(req: Request, metadata: PublicRouteMetadata): string {
  const canonicalUrl = absoluteUrl(req, metadata.canonicalPath);
  const imageUrl = absoluteUrl(req, metadata.imagePath);
  const meta = (attrs: Record<string, string>) =>
    `<meta ${Object.entries(attrs)
      .map(([name, value]) => `${name}="${escapeHtmlAttr(value)}"`)
      .join(" ")}>`;
  const link = (attrs: Record<string, string>) =>
    `<link ${Object.entries(attrs)
      .map(([name, value]) => `${name}="${escapeHtmlAttr(value)}"`)
      .join(" ")}>`;

  return [
    meta({ name: "description", content: metadata.description }),
    link({ rel: "canonical", href: canonicalUrl }),
    meta({ property: "og:type", content: "website" }),
    meta({ property: "og:title", content: metadata.title }),
    meta({ property: "og:description", content: metadata.description }),
    meta({ property: "og:url", content: canonicalUrl }),
    meta({ property: "og:image", content: imageUrl }),
    meta({ name: "twitter:card", content: "summary_large_image" }),
    meta({ name: "twitter:title", content: metadata.title }),
    meta({ name: "twitter:description", content: metadata.description }),
    meta({ name: "twitter:image", content: imageUrl }),
  ].join("\n    ");
}

function withRouteMetadata(
  req: Request,
  html: string,
  metadata: PublicRouteMetadata,
): string {
  const title = `<title>${escapeHtmlAttr(metadata.title)}</title>`;
  const withTitle = /<title>.*?<\/title>/i.test(html)
    ? html.replace(/<title>.*?<\/title>/i, title)
    : html.replace(/<head>/i, `<head>\n    ${title}`);
  const tags = metadataTags(req, metadata);
  return withTitle.replace(/<\/head>/i, `    ${tags}\n  </head>`);
}

function publicMetadataConfigFromCustomize(customize: {
  logoSquareURL?: string;
  siteName?: string;
}): PublicRouteMetadataConfig {
  const launchpad = isLaunchpadMode();
  return {
    cocalc_product: launchpad ? "launchpad" : undefined,
    is_launchpad: launchpad || undefined,
    logo_square: customize.logoSquareURL,
    site_name: customize.siteName,
  };
}

export async function renderPublicAppShell(req: Request): Promise<string> {
  const search = getSearch(req);
  const [customize, template] = await Promise.all([
    getCustomize(["siteName", "logoSquareURL"]),
    readPublicShellTemplate(),
  ]);
  const route = getPublicMetadataRouteFromPath(req.path, search);
  const metadata = getPublicRouteMetadata(
    route,
    publicMetadataConfigFromCustomize(customize),
    { basePath },
  );
  return withRouteMetadata(req, prefixStaticAssetPaths(template), metadata);
}

export async function sendPublicAppShell(
  req: Request,
  res: Response,
): Promise<void> {
  cacheShortTerm(res);
  res.type("html").send(await renderPublicAppShell(req));
}
