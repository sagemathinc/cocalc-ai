/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import type { PublicAuthRoute } from "./auth/routes";
import { getPublicAuthRouteFromPath } from "./auth/routes";
import type { PublicFeaturesRoute } from "./features/routes";
import { getFeaturesRouteFromPath } from "./features/routes";
import type { PublicLangRoute } from "./lang/routes";
import { getLangRouteFromPath, parsePublicLangTarget } from "./lang/routes";
import type { SupportView } from "./support/app";
import { getSupportViewFromPath } from "./support/app";

export type PublicInfoView =
  | "about"
  | "about-events"
  | "about-status"
  | "about-team"
  | "about-team-member"
  | "pricing"
  | "policies"
  | "policies-imprint"
  | "policies-custom"
  | "policies-detail"
  | "news"
  | "news-detail"
  | "news-history"
  | "software"
  | "software-cocalc-launchpad"
  | "software-cocalc-plus";

export interface PublicInfoRoute {
  newsId?: number;
  policySlug?: string;
  teamSlug?: string;
  timestamp?: number;
  view: PublicInfoView;
}

export type PublicRoute =
  | { section: "home" }
  | { route: PublicFeaturesRoute; section: "features" }
  | { route: PublicAuthRoute; section: "auth" }
  | { route: PublicLangRoute; section: "lang" }
  | { section: "support"; view: SupportView }
  | { route: PublicInfoRoute; section: "info" };

function getBaseOffset(): number {
  return appBasePath === "/"
    ? 0
    : appBasePath.split("/").filter(Boolean).length;
}

function getRouteParts(pathname: string): string[] {
  const parts = pathname.split("?")[0].split("/").filter(Boolean);
  return parts.slice(getBaseOffset());
}

function parseTrailingInteger(segment?: string): number | undefined {
  if (!segment) return;
  const value = Number(segment.split("-").pop());
  if (!Number.isInteger(value) || value < 0) return;
  return value;
}

export function getInfoRouteFromPath(pathname: string): PublicInfoRoute {
  const routeParts = getRouteParts(pathname);

  if (routeParts[0] === "about") {
    if (routeParts[1] === "events") return { view: "about-events" };
    if (routeParts[1] === "status") return { view: "about-status" };
    if (routeParts[1] === "team" && routeParts[2]) {
      return { teamSlug: routeParts[2], view: "about-team-member" };
    }
    if (routeParts[1] === "team") return { view: "about-team" };
    return { view: "about" };
  }

  if (routeParts[0] === "pricing") {
    return { view: "pricing" };
  }

  if (routeParts[0] === "policies") {
    if (routeParts[1] === "imprint") return { view: "policies-imprint" };
    if (routeParts[1] === "policies") return { view: "policies-custom" };
    if (routeParts[1]) {
      return { policySlug: routeParts[1], view: "policies-detail" };
    }
    return { view: "policies" };
  }

  if (routeParts[0] === "news") {
    if (routeParts[1] === "rss.xml" || routeParts[1] === "feed.json") {
      return { view: "news" };
    }
    const newsId = parseTrailingInteger(routeParts[1]);
    const timestamp = parseTrailingInteger(routeParts[2]);
    if (newsId != null && timestamp != null) {
      return { newsId, timestamp, view: "news-history" };
    }
    if (newsId != null) {
      return { newsId, view: "news-detail" };
    }
    return { view: "news" };
  }

  if (routeParts[0] === "software") {
    if (routeParts[1] === "cocalc-launchpad") {
      return { view: "software-cocalc-launchpad" };
    }
    if (routeParts[1] === "cocalc-plus") {
      return { view: "software-cocalc-plus" };
    }
    return { view: "software" };
  }

  return { view: "about" };
}

export function getPublicRouteFromPath(
  pathname: string,
  search?: string,
): PublicRoute {
  const routeParts = getRouteParts(pathname);

  if (routeParts.length === 0) {
    return { section: "home" };
  }

  if (routeParts[0] === "features") {
    return { route: getFeaturesRouteFromPath(pathname), section: "features" };
  }

  if (routeParts[0] === "support") {
    return { section: "support", view: getSupportViewFromPath(pathname) };
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

  if (routeParts[0] === "lang" || parsePublicLangTarget(pathname) != null) {
    return { route: getLangRouteFromPath(pathname), section: "lang" };
  }

  return { route: getInfoRouteFromPath(pathname), section: "info" };
}

export function topLevelInfoView(
  route: PublicInfoRoute,
): "about" | "pricing" | "policies" | "news" | "software" {
  switch (route.view) {
    case "pricing":
      return "pricing";
    case "policies":
    case "policies-imprint":
    case "policies-custom":
    case "policies-detail":
      return "policies";
    case "news":
    case "news-detail":
    case "news-history":
      return "news";
    case "software":
    case "software-cocalc-launchpad":
    case "software-cocalc-plus":
      return "software";
    default:
      return "about";
  }
}

export function isPublicTarget(target?: string | null): target is string {
  if (!target) return false;
  return /\/(auth|sso|redeem|features|support|about|pricing|policies|news|software|lang|[a-z]{2}(-[A-Z]{2})?)(\/|$)/.test(
    target,
  );
}

export function publicPath(view: string): string {
  const base = appBasePath === "/" ? "" : appBasePath;
  return `${base}/${view}`;
}
