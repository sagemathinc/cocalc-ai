import { APP_ROUTES } from "@cocalc/util/routing/app";
import type { Request } from "express";
import { isLockedDownPublicSiteHost } from "@cocalc/util/public-site-policy";
import { sitemapLocation } from "./sitemap";

// Verify the cocalc.ai policy against a local hub with:
// curl -H 'Host: cocalc.ai' http://127.0.0.1:9100/robots.txt
// Compare a branded deployment with:
// curl -H 'Host: university.example.edu' http://127.0.0.1:9100/robots.txt
const INDEXABLE_APP_ROUTES = new Set(["share"]);

function renderLockedDownRobots(): string {
  return ["User-agent: *", "Allow: /share", "Disallow: /", ""].join("\n");
}

function renderPublicRobots(req: Request): string {
  // These are authenticated app-shell routes. They may render HTML, but they are
  // not public landing/share content and should not compete with crawlable
  // marketing, docs, or shared-file URLs.
  const privateAppRoutes = Array.from(APP_ROUTES)
    .filter((route) => !INDEXABLE_APP_ROUTES.has(route))
    .map((route) => `Disallow: /${route}`);

  return [
    "User-agent: *",
    // Public pages are served at clean URLs. Branded sites also allow the
    // duplicated marketing routes to be crawled so search engines can read
    // their cross-domain canonical tags pointing at cocalc.ai.
    "Allow: /",
    // Shared files are intentionally public when a user creates a share link,
    // and /share is one of the few app routes that should be indexable.
    "Allow: /share",
    "Allow: /share/",
    // Public pages need hashed JS/CSS/image chunks from /static. The shell HTML
    // files themselves are blocked below: the public shell so crawlers prefer
    // the clean canonical URLs, and the authenticated app/embed shells because
    // they are thin app bootstraps, not public content.
    "Allow: /static/",
    "Disallow: /static/public.html",
    "Disallow: /static/app.html",
    "Disallow: /static/embed.html",
    "Disallow: /static/ultralite.html",
    "Disallow: /essential",
    // The wildcard covers all public-viewer*.html share-viewer shells while
    // leaving the public-viewer*-<hash>.js entry chunks fetchable — crawlers
    // need those bundles to render indexable /share pages.
    "Disallow: /static/public-viewer*.html",
    // These are implementation surfaces, not standalone public pages.
    "Disallow: /webapp/",
    "Disallow: /cdn/",
    "Disallow: /api/",
    ...privateAppRoutes,
    `Sitemap: ${sitemapLocation(req, "/sitemap.xml")}`,
    "",
  ].join("\n");
}

export default function getHandler() {
  return (req, res) => {
    res.header("Content-Type", "text/plain");
    res.header("Cache-Control", "public, max-age=3600, must-revalidate");
    res.vary("Host");
    const host = req.get("host");
    if (isLockedDownPublicSiteHost(host)) {
      // Local development and cocalc.ai subdomains must not be indexed.
      res.send(renderLockedDownRobots());
      return;
    }
    res.send(renderPublicRobots(req));
  };
}
