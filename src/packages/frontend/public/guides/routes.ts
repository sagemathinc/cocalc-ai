/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";

export type PublicGuidesRoute = { view: "index" } | { view: "rstudio-project" };

function getBaseOffset(): number {
  return appBasePath === "/"
    ? 0
    : appBasePath.split("/").filter(Boolean).length;
}

function getRouteParts(pathname: string): string[] {
  const parts = pathname.split("?")[0].split("/").filter(Boolean);
  return parts.slice(getBaseOffset());
}

export function getGuidesRouteFromPath(
  pathname: string,
): PublicGuidesRoute | null {
  const routeParts = getRouteParts(pathname);

  if (routeParts[0] !== "guides") {
    return null;
  }

  if (routeParts.length === 1) {
    return { view: "index" };
  }

  if (routeParts[1] === "rstudio-project" && routeParts.length === 2) {
    return { view: "rstudio-project" };
  }

  return null;
}
