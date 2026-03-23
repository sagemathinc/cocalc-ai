/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";

export interface PublicFeaturesRoute {
  slug?: string;
  view: "index" | "detail";
}

export function featurePath(slug?: string): string {
  const base = appBasePath === "/" ? "" : appBasePath;
  if (!slug) {
    return `${base}/features`;
  }
  return `${base}/features/${slug}`;
}

export function getFeaturesRouteFromPath(
  pathname: string,
): PublicFeaturesRoute {
  const parts = pathname.split("?")[0].split("/").filter(Boolean);
  const baseOffset =
    appBasePath === "/" ? 0 : appBasePath.split("/").filter(Boolean).length;
  const routeParts = parts.slice(baseOffset);
  if (routeParts[0] === "features" && routeParts[1]) {
    return { slug: routeParts[1], view: "detail" };
  }
  return { view: "index" };
}
