/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";

export type PublicContentView =
  | "about"
  | "about-events"
  | "about-status"
  | "about-team"
  | "about-team-member"
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

export interface PublicContentRoute {
  newsId?: number;
  policySlug?: string;
  teamSlug?: string;
  timestamp?: number;
  view: PublicContentView;
}

function parseTrailingInteger(segment?: string): number | undefined {
  if (!segment) return;
  const value = Number(segment.split("-").pop());
  if (!Number.isInteger(value) || value < 0) return;
  return value;
}

export function getContentRouteFromPath(pathname: string): PublicContentRoute {
  const parts = pathname.split("?")[0].split("/").filter(Boolean);
  const baseOffset =
    appBasePath === "/" ? 0 : appBasePath.split("/").filter(Boolean).length;
  const routeParts = parts.slice(baseOffset);

  if (routeParts[0] === "about") {
    if (routeParts[1] === "events") return { view: "about-events" };
    if (routeParts[1] === "status") return { view: "about-status" };
    if (routeParts[1] === "team" && routeParts[2]) {
      return { teamSlug: routeParts[2], view: "about-team-member" };
    }
    if (routeParts[1] === "team") return { view: "about-team" };
    return { view: "about" };
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

export function topLevelView(
  route: PublicContentRoute,
): "about" | "policies" | "news" | "software" {
  switch (route.view) {
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

export function isPublicContentTarget(
  target?: string | null,
): target is string {
  if (!target) return false;
  return /\/(about|policies|news|software)(\/|$)/.test(target);
}

export function contentPath(view: string): string {
  const base = appBasePath === "/" ? "" : appBasePath;
  return `${base}/${view}`;
}
