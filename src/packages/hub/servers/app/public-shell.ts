/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Request, Response } from "express";
import { existsSync } from "fs";
import { readFile, stat } from "fs/promises";
import { join } from "path";

import basePath from "@cocalc/backend/base-path";
import { getNewsItem } from "@cocalc/database/postgres/news";
import getCustomize from "@cocalc/database/settings/customize";
import { getLogger } from "@cocalc/hub/logger";
import { listVisibleRootfsImages } from "@cocalc/server/rootfs/catalog";
import { slugURL } from "@cocalc/util/news";
import { reuseInFlight } from "@cocalc/util/reuse-in-flight";
import { path as STATIC_PATH } from "@cocalc/static";
import {
  getPublicImageDimensions,
  getPublicMarketingSiteName,
  getPublicMetadataRouteFromPath,
  getPublicRouteMetadata,
  pageTitle,
  parseNewsIdFromSlug,
  PUBLIC_HEAD_PLACEHOLDER,
  PUBLIC_STATIC_BASE_PLACEHOLDER,
  type PublicRouteMetadataConfig,
  stripMarkdownSummary,
} from "@cocalc/util/public-site-metadata";
import {
  rootfsEntryDisplayDescription,
  rootfsEntryDisplayTitle,
  rootfsEntryMatchesImageTarget,
  type RootfsImageEntry,
} from "@cocalc/util/rootfs-images";
import { EVENT_CHANNEL, SYSTEM_CHANNEL } from "@cocalc/util/types/news";
import { initPublicDocsMetadata } from "@cocalc/util/public-site-metadata-docs";
import { joinUrlPath } from "@cocalc/util/url-path";
import {
  getCocalcProduct,
  isLaunchpadProduct,
} from "@cocalc/server/launchpad/mode";

const logger = getLogger("hub:servers:public-shell");

// Docs route metadata (per-entry titles, noindex, 404 detection) needs the
// docs registry, which is only wired in on demand; on the server that is
// simply at startup.
initPublicDocsMetadata();

const FALLBACK_PUBLIC_HTML = `<!DOCTYPE html>
<html>
<head>
  ${PUBLIC_HEAD_PLACEHOLDER}
</head>
<body>
  <div id="cocalc-crash-container"></div>
  <div id="cocalc-load-container"></div>
  <div id="cocalc-scripts-container"></div>
  <div id="cocalc-webapp-container"></div>
</body>
</html>`;

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function requestOrigin(req: Request): string {
  return `${req.protocol}://${req.get("host")}`;
}

function absolutePublicUrl(req: Request, path: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return path;
  return `${requestOrigin(req)}${path.startsWith("/") ? path : `/${path}`}`;
}

function getSearch(req: Request): string {
  return req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
}

function targetFromStaticShell(req: Request): string | undefined {
  if (req.path !== "/static/public.html") return undefined;
  const target = req.query?.target;
  return typeof target === "string" && target.startsWith("/")
    ? target
    : undefined;
}

function metadataPathAndSearch(req: Request): { path: string; search: string } {
  const target = targetFromStaticShell(req);
  if (target) {
    const index = target.indexOf("?");
    if (index >= 0) {
      return {
        path: target.slice(0, index),
        search: target.slice(index),
      };
    }
    return { path: target, search: "" };
  }
  return {
    path: joinUrlPath(basePath, req.path),
    search: getSearch(req),
  };
}

function publicMetadataConfig(req: Request): PublicRouteMetadataConfig {
  const customize = (req as any).cocalcPublicCustomize;
  return {
    cocalc_product: getCocalcProduct(),
    dns: req.get("host"),
    imprint: customize?.imprint,
    is_launchpad: isLaunchpadProduct(),
    logo_square: customize?.logoSquareURL,
    policies: customize?.policies,
    policy_pages: customize?.policy_pages,
    site_name: customize?.siteName,
    terms_of_service_url: customize?.termsOfServiceURL,
  };
}

function metaTag(attrs: Record<string, string>): string {
  const rendered = Object.entries(attrs)
    .map(([name, value]) => `${name}="${htmlEscape(value)}"`)
    .join(" ");
  return `<meta ${rendered}>`;
}

// Extra flag the shell resolvers attach to the route metadata: it steers
// the HTTP status and cache policy, not the rendered head.
type ShellRouteMetadata = ReturnType<typeof getPublicRouteMetadata> & {
  // The catalog could not be read: neither 200 (indexable soft-404 for a
  // bogus URL) nor 404 (drops real pages from the index) is trustworthy.
  serviceUnavailable?: boolean;
};

// The registry maps the default Launchpad brand to the canonical marketing
// site name; the DB-backed resolvers must title pages the same way.
function marketingSiteName(req: Request): string {
  return getPublicMarketingSiteName(publicMetadataConfig(req));
}

// News detail metadata cannot come from the shared registry-based helper:
// the post lives in the database. Resolve it here so /news/<slug>-<id>
// canonicalizes to the post's real slug URL (a mistyped slug still resolves
// by id and canonicalizes to the correct URL), gets the actual title and a
// summary, and a nonexistent or unpublished id is a real 404. The by-id
// lookup (instead of scanning the LIMIT-100 recent feed) keeps old posts
// resolvable regardless of news volume; the visibility checks below mirror
// the feed query's WHERE clause (null/future date, expired, hidden, and
// event/system-channel posts are not public).
async function resolveNewsMetadata(
  req: Request,
  route: ReturnType<typeof getPublicMetadataRouteFromPath>,
  metadata: ShellRouteMetadata,
): Promise<ShellRouteMetadata> {
  if (
    route.section !== "news" ||
    (route.route?.view !== "news-detail" &&
      route.route?.view !== "news-history")
  ) {
    return metadata;
  }
  const newsId = parseNewsIdFromSlug(`${route.route.newsSlug}`);
  const item = newsId != null ? await getNewsItem(newsId) : null;
  const now = Date.now() / 1000;
  const date = epochSeconds(item?.date);
  const until = epochSeconds(item?.until);
  if (
    item == null ||
    item.hide ||
    item.channel === EVENT_CHANNEL ||
    item.channel === SYSTEM_CHANNEL ||
    date == null ||
    date > now ||
    (until != null && until <= now)
  ) {
    return { ...metadata, notFound: true };
  }
  const description = stripMarkdownSummary(item.text);
  return {
    ...metadata,
    canonicalPath: joinUrlPath(basePath, slugURL(item)),
    ...(description ? { description } : {}),
    notFound: false,
    title: pageTitle(item.title, marketingSiteName(req)),
  };
}

function epochSeconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.valueOf() / 1000;
  return undefined;
}

// Anonymous catalog visibility is what crawlers see, and it is what every
// requester gets: the public shell is a shared, cacheable, auth-independent
// surface, and metadata that varied by cookie could be replayed across
// users by a shared cache. A privately-visible image therefore 404s here
// even for its owner — the client still renders the real page from its
// authenticated catalog RPC; only the status code and pre-hydration head
// are generic. The short TTL keeps bogus-slug crawls from becoming a
// catalog query per request; reuseInFlight coalesces concurrent fills, and
// failures are never cached.
const ANONYMOUS_ROOTFS_CATALOG_TTL_MS = 60_000;
let anonymousRootfsCatalog:
  | { at: number; images: RootfsImageEntry[] }
  | undefined;

const anonymousRootfsImages = reuseInFlight(
  async (): Promise<RootfsImageEntry[]> => {
    if (
      anonymousRootfsCatalog != null &&
      Date.now() - anonymousRootfsCatalog.at <= ANONYMOUS_ROOTFS_CATALOG_TTL_MS
    ) {
      return anonymousRootfsCatalog.images;
    }
    const { images } = await listVisibleRootfsImages(undefined);
    anonymousRootfsCatalog = { at: Date.now(), images };
    return images;
  },
);

// Rootfs detail metadata mirrors resolveNewsMetadata: the runtime-image
// catalog lives in the database, so resolve the image server-side. An
// unknown slug/id becomes a real 404 instead of echoing the requested path
// into canonical/og tags (a soft-404 crawlers would index); a known image
// gets its real title/description and canonicalizes to its slug URL when it
// has one.
async function resolveRootfsMetadata(
  req: Request,
  route: ReturnType<typeof getPublicMetadataRouteFromPath>,
  metadata: ShellRouteMetadata,
): Promise<ShellRouteMetadata> {
  if (
    route.section !== "rootfs" ||
    (route.route?.view !== "slug" && route.route?.view !== "image-id")
  ) {
    return metadata;
  }
  let images: RootfsImageEntry[];
  try {
    images = await anonymousRootfsImages();
  } catch (err) {
    // A transient catalog error must not 404 real image pages out of the
    // search index, and a 200 with fabricated metadata would recreate the
    // indexable soft-404. Serve 503 so crawlers retry later; the shell
    // still renders and the client loads the catalog itself.
    logger.warn("resolving rootfs metadata failed", { err: `${err}` });
    return { ...metadata, serviceUnavailable: true };
  }
  const target = route.route;
  // Matching mirrors useSelectedRootfsImage in
  // @cocalc/frontend/public/rootfs/app.tsx, so server and client agree on
  // which entry (if any) a URL denotes.
  const entry =
    target.view === "slug"
      ? images.find((it) => it.slug === target.slug)
      : images.find((it) => rootfsEntryMatchesImageTarget(it, target.imageId));
  if (entry == null) {
    return { ...metadata, notFound: true };
  }
  const slug = entry.slug?.trim();
  const canonicalPath = joinUrlPath(
    basePath,
    slug
      ? `rootfs/${encodeURIComponent(slug)}`
      : `rootfs/id/${encodeURIComponent(entry.id)}`,
  );
  const description = stripMarkdownSummary(
    rootfsEntryDisplayDescription(entry),
  );
  return {
    ...metadata,
    canonicalPath,
    ...(description ? { description } : {}),
    notFound: false,
    title: pageTitle(rootfsEntryDisplayTitle(entry), marketingSiteName(req)),
  };
}

// A news detail URL that is not the post's canonical slug URL (bare id
// /news/<id>, mistyped or outdated slug) permanently redirects instead of
// serving duplicate content. Only news-detail: a history view intentionally
// canonicalizes to the current post while still serving the history page,
// and /rootfs/id/<id> stays a stable alias consolidated via its canonical
// tag. Static-shell requests (?target=...) are exempt — their serving URL
// legitimately differs from the canonical clean URL.
function newsRedirectPath(
  req: Request,
  route: ReturnType<typeof getPublicMetadataRouteFromPath>,
  metadata: ShellRouteMetadata,
  path: string,
): string | undefined {
  if (
    route.section !== "news" ||
    route.route?.view !== "news-detail" ||
    metadata.notFound ||
    !metadata.canonicalPath.startsWith("/") ||
    metadata.canonicalPath === path ||
    targetFromStaticShell(req) != null
  ) {
    return undefined;
  }
  // The route parser maps /news/<slug>-<id>/<timestamp> history views to
  // news-detail as well; only a plain /news/<segment> path is a detail
  // alias that may redirect.
  const base = basePath.split("/").filter(Boolean).length;
  if (path.split("/").filter(Boolean).length - base !== 2) {
    return undefined;
  }
  return metadata.canonicalPath;
}

async function buildHead(req: Request): Promise<{
  head: string;
  notFound: boolean;
  redirectTo?: string;
  serviceUnavailable: boolean;
}> {
  const { path, search } = metadataPathAndSearch(req);
  const route = getPublicMetadataRouteFromPath(path, search, {
    basePath,
  });
  let metadata: ShellRouteMetadata = getPublicRouteMetadata(
    route,
    publicMetadataConfig(req),
    { basePath },
  );
  metadata = await resolveNewsMetadata(req, route, metadata);
  metadata = await resolveRootfsMetadata(req, route, metadata);
  const redirectPath = newsRedirectPath(req, route, metadata, path);
  const canonicalUrl = absolutePublicUrl(req, metadata.canonicalPath);
  const imageUrl = absolutePublicUrl(req, metadata.imagePath);
  const imageDimensions = getPublicImageDimensions(metadata.imagePath);
  const socialTags = [
    ...(metadata.noindex
      ? [
          metaTag({
            content: "noindex",
            "data-cocalc-public-route-meta": "robots",
            name: "robots",
          }),
        ]
      : []),
    metaTag({
      content: metadata.description,
      "data-cocalc-public-route-meta": "description",
      name: "description",
    }),
    `<link data-cocalc-public-route-meta="canonical" href="${htmlEscape(
      canonicalUrl,
    )}" rel="canonical">`,
    metaTag({
      content: "website",
      "data-cocalc-public-route-meta": "og:type",
      property: "og:type",
    }),
    metaTag({
      content: metadata.title,
      "data-cocalc-public-route-meta": "og:title",
      property: "og:title",
    }),
    metaTag({
      content: metadata.description,
      "data-cocalc-public-route-meta": "og:description",
      property: "og:description",
    }),
    metaTag({
      content: canonicalUrl,
      "data-cocalc-public-route-meta": "og:url",
      property: "og:url",
    }),
    metaTag({
      content: imageUrl,
      "data-cocalc-public-route-meta": "og:image",
      property: "og:image",
    }),
    ...(imageDimensions
      ? [
          metaTag({
            content: `${imageDimensions.width}`,
            "data-cocalc-public-route-meta": "og:image:width",
            property: "og:image:width",
          }),
          metaTag({
            content: `${imageDimensions.height}`,
            "data-cocalc-public-route-meta": "og:image:height",
            property: "og:image:height",
          }),
        ]
      : []),
    metaTag({
      content: "summary_large_image",
      "data-cocalc-public-route-meta": "twitter:card",
      name: "twitter:card",
    }),
    metaTag({
      content: metadata.title,
      "data-cocalc-public-route-meta": "twitter:title",
      name: "twitter:title",
    }),
    metaTag({
      content: metadata.description,
      "data-cocalc-public-route-meta": "twitter:description",
      name: "twitter:description",
    }),
    metaTag({
      content: imageUrl,
      "data-cocalc-public-route-meta": "twitter:image",
      name: "twitter:image",
    }),
  ].join("\n  ");

  return {
    head: `${basePathMetaTag()}\n  <title>${htmlEscape(
      metadata.title,
    )}</title>\n  ${socialTags}`,
    notFound: !!metadata.notFound,
    ...(redirectPath ? { redirectTo: `${redirectPath}${search}` } : {}),
    serviceUnavailable: !!metadata.serviceUnavailable,
  };
}

function staticBasePath(): string {
  return joinUrlPath(basePath, "static");
}

// The client cannot infer the serve-time base path from a clean page URL
// like /docs/a/b, so the shell head states it explicitly;
// @cocalc/frontend/customize/app-base-path reads this tag first.
function basePathMetaTag(): string {
  return `<meta name="cocalc-base-path" content="${htmlEscape(basePath)}">`;
}

// Legacy shells (built before the static-base token) have script URLs
// relative to /static/, so serving them at clean URLs needs a page-wide
// <base> tag. It must come before the plugin-emitted <script> tags, which
// follow the marker region.
// TODO remove together with the legacy branches in injectHead once all
// deployed static artifacts carry PUBLIC_STATIC_BASE_PLACEHOLDER.
function staticBaseTag(): string {
  return `<base href="${htmlEscape(`${staticBasePath()}/`)}">`;
}

// Cache the shell file content keyed by mtime/size: serving public pages is
// hot and the file only changes when static is rebuilt, so a cheap stat per
// request replaces a full read; a rebuild bumps the mtime and refreshes the
// cache automatically (important for dev, where static rebuilds while the
// hub keeps running).
let cachedShell:
  | { file: string; mtimeMs: number; size: number; html: string }
  | undefined;

async function publicHtml(): Promise<string> {
  try {
    const file = join(resolveStaticPath(), "public.html");
    const { mtimeMs, size } = await stat(file);
    if (
      cachedShell != null &&
      cachedShell.file === file &&
      cachedShell.mtimeMs === mtimeMs &&
      cachedShell.size === size
    ) {
      return cachedShell.html;
    }
    const html = await readFile(file, "utf8");
    cachedShell = { file, mtimeMs, size, html };
    return html;
  } catch {
    return FALLBACK_PUBLIC_HTML;
  }
}

// The resolved directory cannot change for the lifetime of the process, so
// resolve it once; a miss (no built static assets yet) is not memoized so a
// build that finishes after hub startup is still picked up.
let resolvedStaticPath: string | undefined;

export function resolveStaticPath(): string {
  if (resolvedStaticPath != null) {
    return resolvedStaticPath;
  }
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
    join(process.cwd(), "packages", "static", "dist"),
    join(__dirname, "..", "static"),
  );
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "app.html"))) {
      resolvedStaticPath = candidate;
      return candidate;
    }
  }
  return STATIC_PATH;
}

let warnedAboutMissingPlaceholder = false;

// Rewrite the shell for serving: resolve the static-base token into the
// serve-time asset location, then replace the shared title placeholder with
// the rendered head using exact string splicing only. Unlike comments, the
// title survives Rspack's production HTML minification. Legacy artifacts
// without the token get a page-wide <base> tag instead — that breaks
// same-page fragment links (href="#..." resolves to /static/#...), which is
// why new artifacts use absolute asset URLs. If the placeholder is missing
// or duplicated, skip the per-route metadata but keep the asset URLs
// working — otherwise the stale shell renders blank. Log so the stale
// static build gets noticed.
function injectHead(html: string, head: string): string {
  const tokenized = html.includes(PUBLIC_STATIC_BASE_PLACEHOLDER);
  if (tokenized) {
    html = html
      .split(PUBLIC_STATIC_BASE_PLACEHOLDER)
      .join(htmlEscape(staticBasePath()));
  }
  const index = html.indexOf(PUBLIC_HEAD_PLACEHOLDER);
  const duplicate =
    index >= 0
      ? html.indexOf(
          PUBLIC_HEAD_PLACEHOLDER,
          index + PUBLIC_HEAD_PLACEHOLDER.length,
        )
      : -1;
  if (index < 0 || duplicate >= 0) {
    if (!warnedAboutMissingPlaceholder) {
      warnedAboutMissingPlaceholder = true;
      logger.warn(
        "public.html must contain exactly one public head placeholder; serving shell without per-route metadata — rebuild @cocalc/static",
      );
    }
    if (tokenized) {
      return html;
    }
    return html.replace(
      /<head[^>]*>/i,
      (match) => `${match}${staticBaseTag()}`,
    );
  }
  const spliced = tokenized ? head : `${staticBaseTag()}\n  ${head}`;
  return (
    html.slice(0, index) +
    spliced +
    html.slice(index + PUBLIC_HEAD_PLACEHOLDER.length)
  );
}

export async function renderPublicShell(req: Request): Promise<{
  html: string;
  redirectTo?: string;
  status: 200 | 404 | 503;
}> {
  const customize = await getCustomize();
  (req as any).cocalcPublicCustomize = customize;
  const html = await publicHtml();
  const { head, notFound, redirectTo, serviceUnavailable } =
    await buildHead(req);
  return {
    html: injectHead(html, head),
    redirectTo,
    status: serviceUnavailable ? 503 : notFound ? 404 : 200,
  };
}

export function servePublicShell(req: Request, res: Response): void {
  void renderPublicShell(req)
    .then(({ html, redirectTo, status }) => {
      if (redirectTo) {
        res.setHeader("Cache-Control", "public, max-age=300");
        res.vary("Host");
        res.redirect(301, redirectTo);
        return;
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      if (status === 503) {
        // An outage response must not be stored by any cache.
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Retry-After", "60");
      } else {
        res.setHeader("Cache-Control", "public, max-age=10, must-revalidate");
      }
      // The body embeds host-derived canonical/og URLs and host-dependent
      // policy, so shared caches must key on the host.
      res.vary("Host");
      res.status(status).send(html);
    })
    .catch((err) => {
      logger.warn("serving public shell failed", { err: `${err}` });
      res.status(500).type("text/plain").send("internal error");
    });
}
