/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";

export type PublicAboutRoute =
  | { view: "about" }
  | { view: "about-events" }
  | { view: "about-team" }
  | { teamSlug: string; view: "about-team-member" };

function getRouteParts(pathname: string): string[] {
  const parts = pathname.split("?")[0].split("/").filter(Boolean);
  const baseOffset =
    appBasePath === "/" ? 0 : appBasePath.split("/").filter(Boolean).length;
  return parts.slice(baseOffset);
}

export function getAboutRouteFromPath(pathname: string): PublicAboutRoute {
  const routeParts = getRouteParts(pathname);
  if (routeParts[1] === "events") return { view: "about-events" };
  if (routeParts[1] === "team" && routeParts[2]) {
    return { teamSlug: routeParts[2], view: "about-team-member" };
  }
  if (routeParts[1] === "team") return { view: "about-team" };
  return { view: "about" };
}
