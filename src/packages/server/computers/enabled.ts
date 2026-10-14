/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The site's switch for computers (Admin → Site Settings → AI & Agents →
// Computers), off by default. When it is off, nothing can request, pair,
// approve or use a computer; owners can still list theirs, decline requests
// and revoke. Settings are cached for a few seconds, so turning it off takes
// effect within that.

import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { ComputerRequestError } from "./requests";

export const COMPUTERS_DISABLED =
  "Computers are turned off on this site. An admin can turn them on in Admin → Site Settings (Enable Computers).";

export async function computersEnabled(): Promise<boolean> {
  return (await getServerSettings()).computers_enabled === true;
}

export async function assertComputersEnabled(): Promise<void> {
  if (!(await computersEnabled())) {
    throw new ComputerRequestError(COMPUTERS_DISABLED);
  }
}
