/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type SupportView = "index" | "new" | "tickets" | "community";

export interface PublicSupportRoute {
  view: SupportView;
}

export function getSupportViewFromPath(
  pathname: string,
): SupportView | undefined {
  const path = pathname.split("?")[0].replace(/\/+$/, "");
  if (path.endsWith("/support/community")) {
    return "community";
  }
  if (path.endsWith("/support/new")) {
    return "new";
  }
  if (path.endsWith("/support/tickets")) {
    return "tickets";
  }
  if (path.endsWith("/support")) {
    return "index";
  }
  return undefined;
}
