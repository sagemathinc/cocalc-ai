/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";

export type PublicContentView =
  | "about"
  | "about-events"
  | "about-team"
  | "policies"
  | "policies-imprint"
  | "policies-custom"
  | "news"
  | "news-detail"
  | "news-history";

export interface PublicContentRoute {
  newsId?: number;
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
    if (routeParts[1] === "team") return { view: "about-team" };
    return { view: "about" };
  }

  if (routeParts[0] === "policies") {
    if (routeParts[1] === "imprint") return { view: "policies-imprint" };
    if (routeParts[1] === "policies") return { view: "policies-custom" };
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

  return { view: "about" };
}

export function topLevelView(
  route: PublicContentRoute,
): "about" | "policies" | "news" {
  switch (route.view) {
    case "policies":
    case "policies-imprint":
    case "policies-custom":
      return "policies";
    case "news":
    case "news-detail":
    case "news-history":
      return "news";
    default:
      return "about";
  }
}

export function contentPath(view: string): string {
  const base = appBasePath === "/" ? "" : appBasePath;
  return `${base}/${view}`;
}
