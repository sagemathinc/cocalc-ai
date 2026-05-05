/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";

export type PublicNewsRoute =
  | { view: "news" }
  | { newsId: number; view: "news-detail" }
  | { newsId: number; timestamp: number; view: "news-history" };

function getRouteParts(pathname: string): string[] {
  const parts = pathname.split("?")[0].split("/").filter(Boolean);
  const baseOffset =
    appBasePath === "/" ? 0 : appBasePath.split("/").filter(Boolean).length;
  return parts.slice(baseOffset);
}

function parseTrailingInteger(segment?: string): number | undefined {
  if (!segment) return;
  const value = Number(segment.split("-").pop());
  if (!Number.isInteger(value) || value < 0) return;
  return value;
}

export function getNewsRouteFromPath(pathname: string): PublicNewsRoute {
  const routeParts = getRouteParts(pathname);
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
