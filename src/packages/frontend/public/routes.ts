/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import type { PublicAboutRoute } from "./about/routes";
import { getAboutRouteFromPath } from "./about/routes";
import type { PublicAuthRoute } from "./auth/routes";
import { getPublicAuthRouteFromPath } from "./auth/routes";
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
import type { PublicSupportRoute } from "./support/routes";
import { getSupportViewFromPath } from "./support/routes";

export type PublicRoute =
  | { section: "home" }
  | { route: PublicAboutRoute; section: "about" }
  | { route: PublicAuthRoute; section: "auth" }
  | { route: PublicFeaturesRoute; section: "features" }
  | { route: PublicLangRoute; section: "lang" }
  | { route: PublicNewsRoute; section: "news" }
  | { section: "not-found" }
  | { route: PublicPoliciesRoute; section: "policies" }
  | { section: "pricing" }
  | { route: PublicProductsRoute; section: "products" }
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
    routeParts[0] === "sso" ||
    routeParts[0] === "redeem"
  ) {
    return {
      route: getPublicAuthRouteFromPath(pathname, search),
      section: "auth",
    };
  }

  if (routeParts[0] === "features") {
    return { route: getFeaturesRouteFromPath(pathname), section: "features" };
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

  if (routeParts[0] === "support") {
    return {
      route: { view: getSupportViewFromPath(pathname) },
      section: "support",
    };
  }

  return { section: "not-found" };
}

export function isPublicTarget(target?: string | null): target is string {
  if (!target) return false;
  if (
    target === "/" ||
    target === appBasePath ||
    target === `${appBasePath}/`
  ) {
    return true;
  }
  return /\/(about|auth|sso|redeem|features|lang|news|policies|pricing|products|support|[a-z]{2}(-[A-Z]{2})?)(\/|$|\?|#)/.test(
    target,
  );
}

export function publicPath(view: string): string {
  const base = appBasePath === "/" ? "" : appBasePath;
  return `${base}/${view}`;
}
