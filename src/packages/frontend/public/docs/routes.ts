/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";

export type PublicDocsRoute =
  | { view: "docs-index" }
  | { view: "docs-print" }
  | { slug: string; view: "docs-detail" };

function getBaseOffset(): number {
  return appBasePath === "/"
    ? 0
    : appBasePath.split("/").filter(Boolean).length;
}

export function getDocsRouteFromPath(pathname: string): PublicDocsRoute {
  const parts = pathname
    .split("?")[0]
    .split("#")[0]
    .split("/")
    .filter(Boolean)
    .slice(getBaseOffset());
  const slug = parts.slice(1).join("/");
  if (!slug) {
    return { view: "docs-index" };
  }
  if (slug === "print") {
    return { view: "docs-print" };
  }
  return { slug, view: "docs-detail" };
}
