/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type SupportView = "index" | "new" | "tickets" | "community" | "status";

export interface PublicSupportRoute {
  view: SupportView;
}

export function getSupportViewFromPath(pathname: string): SupportView {
  if (pathname.includes("/support/status")) {
    return "status";
  }
  if (pathname.includes("/support/community")) {
    return "community";
  }
  if (pathname.includes("/support/new")) {
    return "new";
  }
  if (pathname.includes("/support/tickets")) {
    return "tickets";
  }
  return "index";
}
