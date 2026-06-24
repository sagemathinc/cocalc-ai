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
  getPublicImageDimensions,
  getPublicMetadataRouteFromPath,
  getPublicRouteMetadata,
  PUBLIC_SITE_DESCRIPTION,
  type PublicMetadataRoute,
  type PublicRouteMetadata,
  type PublicRouteMetadataConfig,
} from "@cocalc/util/public-site-metadata";
import { DEFAULT_LOCALE, isLocale } from "@cocalc/util/i18n/locale";
import { path as STATIC_PATH } from "@cocalc/static";
import { joinUrlPath } from "@cocalc/util/url-path";
import { isLaunchpadMode } from "@cocalc/server/software-licenses/activation";

const SHORT_AGE = Math.round(ms("10 seconds") / 1000);
const FALLBACK_PUBLIC_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
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

function publicShellPath(view = ""): string {
  const base = basePath === "/" ? "" : basePath.replace(/\/+$/, "");
  const normalized = view.replace(/^\/+/, "");
  return normalized ? `${base}/${normalized}` : `${base}/`;
}

function absolutePublicShellUrl(req: Request, view = ""): string {
  return absoluteUrl(req, publicShellPath(view));
}

function prefixStaticAssetPaths(html: string): string {
  const staticBase = joinUrlPath(basePath, "static");
  return html.replace(
    /\b(src|href)="((?![a-z][a-z0-9+.-]*:|\/|#)[^"]+)"/gi,
    (_match, attr: string, value: string) => `${attr}="${staticBase}/${value}"`,
  );
}

function htmlLangForRoute(route: PublicMetadataRoute): string {
  const routeLocale =
    route.section === "lang" && typeof route.route?.locale === "string"
      ? route.route.locale
      : undefined;
  return isLocale(routeLocale) ? routeLocale : DEFAULT_LOCALE;
}

function ogLocaleForRoute(route: PublicMetadataRoute): string {
  const lang = htmlLangForRoute(route);
  if (lang === DEFAULT_LOCALE) return "en_US";
  return lang.replace("-", "_");
}

function withHtmlLang(html: string, lang: string): string {
  return html.replace(/<html\b([^>]*)>/i, (_match, attrs: string) => {
    const nextAttrs = /\slang=/i.test(attrs)
      ? attrs.replace(/\slang=(["']).*?\1/i, ` lang="${escapeHtmlAttr(lang)}"`)
      : `${attrs} lang="${escapeHtmlAttr(lang)}"`;
    return `<html${nextAttrs}>`;
  });
}

function insertAfterHeadOpen(html: string, tag: string): string {
  return html.replace(/<head>/i, `<head>\n    ${tag}`);
}

function withServedHtmlBasics(
  html: string,
  route: PublicMetadataRoute,
): string {
  const viewport =
    '<meta name="viewport" content="width=device-width, initial-scale=1" />';
  const charset = '<meta charset="utf-8" />';
  let next = withHtmlLang(html, htmlLangForRoute(route));
  if (/<meta\s+charset=(["']).*?\1\s*\/?>/i.test(next)) {
    next = next.replace(/<meta\s+charset=(["']).*?\1\s*\/?>/i, charset);
  } else {
    next = insertAfterHeadOpen(next, charset);
  }
  if (/<meta\s+name=(["'])viewport\1[^>]*>/i.test(next)) {
    next = next.replace(/<meta\s+name=(["'])viewport\1[^>]*>/i, viewport);
  } else {
    next = next.replace(charset, `${charset}\n    ${viewport}`);
  }
  return next;
}

function metadataTags(
  req: Request,
  route: PublicMetadataRoute,
  metadata: PublicRouteMetadata,
): string {
  const canonicalUrl = absoluteUrl(req, metadata.canonicalPath);
  const imageUrl = absoluteUrl(req, metadata.imagePath);
  const imageDimensions = getPublicImageDimensions(metadata.imagePath);
  const siteName = siteNameFromMetadata(metadata);
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
    meta({ property: "og:site_name", content: siteName }),
    meta({ property: "og:locale", content: ogLocaleForRoute(route) }),
    ...(imageDimensions
      ? [
          meta({
            property: "og:image:width",
            content: `${imageDimensions.width}`,
          }),
          meta({
            property: "og:image:height",
            content: `${imageDimensions.height}`,
          }),
        ]
      : []),
    meta({ name: "twitter:card", content: "summary_large_image" }),
    meta({ name: "twitter:title", content: metadata.title }),
    meta({ name: "twitter:description", content: metadata.description }),
    meta({ name: "twitter:image", content: imageUrl }),
  ].join("\n    ");
}

function siteNameFromMetadata(metadata: PublicRouteMetadata): string {
  const separator = " | ";
  const index = metadata.title.lastIndexOf(separator);
  if (index === -1) return metadata.title;
  return metadata.title.slice(index + separator.length);
}

function pageNameFromMetadata(metadata: PublicRouteMetadata): string {
  const separator = " | ";
  const index = metadata.title.lastIndexOf(separator);
  if (index === -1) return metadata.title;
  return metadata.title.slice(0, index);
}

function isFeatureDetailRoute(route: PublicMetadataRoute): boolean {
  return route.section === "features" && typeof route.route?.slug === "string";
}

function isProductDetailRoute(route: PublicMetadataRoute): boolean {
  return (
    route.section === "products" &&
    typeof route.route?.view === "string" &&
    route.route.view !== "products"
  );
}

function breadcrumbJsonLd(
  req: Request,
  route: PublicMetadataRoute,
  metadata: PublicRouteMetadata,
): object | undefined {
  const section =
    route.section === "features"
      ? { name: "Features", path: "features" }
      : route.section === "products"
        ? { name: "Products", path: "products" }
        : undefined;
  if (
    !section ||
    (!isFeatureDetailRoute(route) && !isProductDetailRoute(route))
  ) {
    return;
  }
  return {
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        item: absolutePublicShellUrl(req),
        name: "CoCalc",
        position: 1,
      },
      {
        "@type": "ListItem",
        item: absolutePublicShellUrl(req, section.path),
        name: section.name,
        position: 2,
      },
      {
        "@type": "ListItem",
        item: absoluteUrl(req, metadata.canonicalPath),
        name: pageNameFromMetadata(metadata),
        position: 3,
      },
    ],
  };
}

function productJsonLd(
  req: Request,
  route: PublicMetadataRoute,
  metadata: PublicRouteMetadata,
): object | undefined {
  if (!isProductDetailRoute(route)) return;
  return {
    "@id": `${absoluteUrl(req, metadata.canonicalPath)}#product`,
    "@type": "Product",
    brand: { "@type": "Brand", name: "CoCalc" },
    description: metadata.description,
    image: absoluteUrl(req, metadata.imagePath),
    name: pageNameFromMetadata(metadata),
    url: absoluteUrl(req, metadata.canonicalPath),
  };
}

function faqJsonLd(metadata: PublicRouteMetadata): object | undefined {
  if (!metadata.faq?.length) return;
  return {
    "@type": "FAQPage",
    mainEntity: metadata.faq.map((item) => ({
      "@type": "Question",
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
      name: item.question,
    })),
  };
}

function jsonScript(value: object): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function jsonLdTags(
  req: Request,
  route: PublicMetadataRoute,
  metadata: PublicRouteMetadata,
): string {
  const siteUrl = absolutePublicShellUrl(req);
  const organizationId = `${siteUrl}#organization`;
  const softwareId = `${siteUrl}#software`;
  const graph = [
    {
      "@id": organizationId,
      "@type": "Organization",
      name: "SageMath, Inc.",
      url: siteUrl,
    },
    {
      "@id": softwareId,
      "@type": "SoftwareApplication",
      applicationCategory: "DeveloperApplication",
      description: PUBLIC_SITE_DESCRIPTION,
      name: "CoCalc",
      operatingSystem: "Web",
      publisher: { "@id": organizationId },
      url: siteUrl,
    },
    productJsonLd(req, route, metadata),
    breadcrumbJsonLd(req, route, metadata),
    faqJsonLd(metadata),
  ].filter(Boolean);

  return `<script type="application/ld+json">${jsonScript({
    "@context": "https://schema.org",
    "@graph": graph,
  })}</script>`;
}

function withRouteMetadata(
  req: Request,
  html: string,
  route: PublicMetadataRoute,
  metadata: PublicRouteMetadata,
): string {
  const title = `<title>${escapeHtmlAttr(metadata.title)}</title>`;
  const withTitle = /<title>.*?<\/title>/i.test(html)
    ? html.replace(/<title>.*?<\/title>/i, title)
    : html.replace(/<head>/i, `<head>\n    ${title}`);
  const tags = [
    metadataTags(req, route, metadata),
    jsonLdTags(req, route, metadata),
  ].join("\n    ");
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
  return withRouteMetadata(
    req,
    withServedHtmlBasics(prefixStaticAssetPaths(template), route),
    route,
    metadata,
  );
}

export async function sendPublicAppShell(
  req: Request,
  res: Response,
): Promise<void> {
  cacheShortTerm(res);
  res.type("html").send(await renderPublicAppShell(req));
}
