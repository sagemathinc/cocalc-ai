/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";

export type PublicPoliciesRoute =
  | { view: "policies" }
  | { view: "policies-imprint" }
  | { view: "policies-custom" }
  | { policySlug: string; view: "policies-detail" };

function getRouteParts(pathname: string): string[] {
  const parts = pathname.split("?")[0].split("/").filter(Boolean);
  const baseOffset =
    appBasePath === "/" ? 0 : appBasePath.split("/").filter(Boolean).length;
  return parts.slice(baseOffset);
}

export function getPoliciesRouteFromPath(
  pathname: string,
): PublicPoliciesRoute {
  const routeParts = getRouteParts(pathname);
  if (routeParts[1] === "imprint") return { view: "policies-imprint" };
  if (routeParts[1] === "policies") return { view: "policies-custom" };
  if (routeParts[1]) {
    return { policySlug: routeParts[1], view: "policies-detail" };
  }
  return { view: "policies" };
}
