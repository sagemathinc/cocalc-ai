/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { getPublicPermanentRedirectPath } from "@cocalc/util/public-site-metadata";
import { HOST_ABSOLUTE_ROUTE_PREFIXES } from "@cocalc/util/routing/app";
import type { PublicAboutRoute } from "./about/routes";
import { getAboutRouteFromPath } from "./about/routes";
import type { PublicAuthRoute } from "./auth/routes";
import {
  getPublicAuthRouteFromPath,
  isPublicAuthRoutePath,
} from "./auth/routes";
import type { PublicDocsRoute } from "./docs/routes";
import { getDocsRouteFromPath } from "./docs/routes";
import type { PublicFeaturesRoute } from "./features/routes";
import { getFeaturesRouteFromPath } from "./features/routes";
import type { PublicLangRoute } from "./lang/routes";
import { getLangRouteFromPath, parsePublicLangTarget } from "./lang/routes";
import type { PublicNewsRoute } from "./news/routes";
import { getNewsRouteFromPath } from "./news/routes";
import type { PublicPoliciesRoute } from "./policies/routes";
import { getPoliciesRouteFromPath } from "./policies/routes";
import type { PublicProductsRoute } from "./products/routes";
import { getProductsRouteFromPath } from "./products/routes";
import type { PublicRootfsRoute } from "./rootfs/routes";
import { getRootfsRouteFromPath } from "./rootfs/routes";
import type { PublicSupportRoute } from "./support/routes";
import { getSupportViewFromPath } from "./support/routes";

export type PublicRoute =
  | { section: "home" }
  | { route: PublicAboutRoute; section: "about" }
  | { route: PublicAuthRoute; section: "auth" }
  | { route: PublicDocsRoute; section: "docs" }
  | { route: PublicFeaturesRoute; section: "features" }
  | { section: "guides" }
  | { route: PublicLangRoute; section: "lang" }
  | { route: PublicNewsRoute; section: "news" }
  | { section: "not-found" }
  | { route: PublicPoliciesRoute; section: "policies" }
  | { section: "pricing" }
  | { route: PublicProductsRoute; section: "products" }
  | { route: PublicRootfsRoute; section: "rootfs" }
  | { route: PublicSupportRoute; section: "support" };

function getBaseOffset(): number {
  return appBasePath === "/"
    ? 0
    : appBasePath.split("/").filter(Boolean).length;
}

function getRouteParts(pathname: string): string[] {
  const parts = pathname.split("?")[0].split("/").filter(Boolean);
  return parts.slice(getBaseOffset());
}

export function getPublicRouteFromPath(
  pathname: string,
  search?: string,
): PublicRoute {
  const routeParts = getRouteParts(pathname);

  if (routeParts.length === 0) {
    return { section: "home" };
  }

  if (routeParts[0] === "about") {
    return { route: getAboutRouteFromPath(pathname), section: "about" };
  }

  if (
    routeParts[0] === "auth" ||
    routeParts[0] === "invites" ||
    routeParts[0] === "sso" ||
    routeParts[0] === "redeem"
  ) {
    return {
      route: getPublicAuthRouteFromPath(pathname, search),
      section: "auth",
    };
  }

  if (routeParts[0] === "docs") {
    return { route: getDocsRouteFromPath(pathname), section: "docs" };
  }

  if (routeParts[0] === "features") {
    return { route: getFeaturesRouteFromPath(pathname), section: "features" };
  }

  if (routeParts[0] === "guides") {
    return routeParts.length === 1
      ? { section: "guides" }
      : { section: "not-found" };
  }

  if (routeParts[0] === "lang" || parsePublicLangTarget(pathname) != null) {
    return { route: getLangRouteFromPath(pathname), section: "lang" };
  }

  if (routeParts[0] === "news") {
    return { route: getNewsRouteFromPath(pathname), section: "news" };
  }

  if (routeParts[0] === "policies") {
    return { route: getPoliciesRouteFromPath(pathname), section: "policies" };
  }

  if (routeParts[0] === "pricing") {
    return { section: "pricing" };
  }

  if (routeParts[0] === "products") {
    return { route: getProductsRouteFromPath(pathname), section: "products" };
  }

  if (routeParts[0] === "rootfs") {
    return { route: getRootfsRouteFromPath(pathname), section: "rootfs" };
  }

  if (routeParts[0] === "support") {
    const view = getSupportViewFromPath(pathname);
    if (view == null) {
      return { section: "not-found" };
    }
    return {
      route: { view },
      section: "support",
    };
  }

  return { section: "not-found" };
}

const PUBLIC_TARGET_SECTIONS = new Set([
  "about",
  "auth",
  "invites",
  "sso",
  "redeem",
  "docs",
  "features",
  "guides",
  "lang",
  "news",
  "policies",
  "pricing",
  "products",
  "rootfs",
  "support",
]);

// Route segments that belong to the webapp (or other server handlers), not
// the public SPA. Hitting one of these while scanning must force a full
// navigation — matching public section names anywhere in the path would
// wrongly claim app routes like /admin/news for the public router.
const APP_ROUTE_SEGMENTS = new Set(
  HOST_ABSOLUTE_ROUTE_PREFIXES.map((prefix) => prefix.replace(/^\/+/, "")),
);

// Whether the target is handled by the public SPA. Scans path segments from
// the left: unknown leading segments are tolerated as a (possibly foreign)
// base path prefix, the first public section claims the target, and the
// first app-route segment rejects it.
export function isPublicTarget(target?: string | null): target is string {
  if (!target) return false;
  if (
    target === "/" ||
    target === appBasePath ||
    target === `${appBasePath}/`
  ) {
    return true;
  }
  let url: URL;
  try {
    url = new URL(target, "https://example.invalid");
  } catch {
    return false;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const section = parts[i];
    if (section === "auth") {
      return isPublicAuthRoutePath(url.pathname, url.search);
    }
    if (section === "guides") {
      // Only the guides index is a public SPA page.
      return parts.length === i + 1;
    }
    if (PUBLIC_TARGET_SECTIONS.has(section)) return true;
    if (APP_ROUTE_SEGMENTS.has(section)) return false;
    // Locale alias roots such as /de or /pt-BR — but only as the final
    // segment, so a two-letter base-path prefix (e.g. /hb/projects) is not
    // mistaken for a locale page.
    if (i === parts.length - 1 && /^[a-z]{2}(-[A-Z]{2})?$/.test(section)) {
      return true;
    }
    // Otherwise: possibly a base-path segment — keep scanning.
  }
  return false;
}

export function preservePublicTargetFragment(
  target: string,
  fragment: string,
): string {
  if (!fragment || fragment === "#") {
    return target;
  }
  const url = new URL(target, "https://example.invalid");
  return url.hash ? target : `${target}${fragment}`;
}

export function publicPath(view: string): string {
  const base = appBasePath === "/" ? "" : appBasePath;
  return `${base}/${view}`;
}

// Where a public URL that moved for good now lives, or undefined. The hub
// answers a direct request with a permanent redirect; the client follows the
// same rule for in-app links and for a page opened through the static shell.
export function getPublicRedirectPath(pathname: string): string | undefined {
  return getPublicPermanentRedirectPath(pathname, { basePath: appBasePath });
}
