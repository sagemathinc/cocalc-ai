/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";

export type PublicProductsRoute =
  | { view: "products" }
  | { view: "products-cocalc-launchpad" }
  | { view: "products-cocalc-plus" }
  | { view: "products-cocalc-rocket" };

function getRouteParts(pathname: string): string[] {
  const parts = pathname.split("?")[0].split("/").filter(Boolean);
  const baseOffset =
    appBasePath === "/" ? 0 : appBasePath.split("/").filter(Boolean).length;
  return parts.slice(baseOffset);
}

export function getProductsRouteFromPath(
  pathname: string,
): PublicProductsRoute {
  const routeParts = getRouteParts(pathname);
  if (routeParts[1] === "cocalc-launchpad") {
    return { view: "products-cocalc-launchpad" };
  }
  if (routeParts[1] === "cocalc-plus") {
    return { view: "products-cocalc-plus" };
  }
  if (routeParts[1] === "cocalc-rocket") {
    return { view: "products-cocalc-rocket" };
  }
  return { view: "products" };
}
