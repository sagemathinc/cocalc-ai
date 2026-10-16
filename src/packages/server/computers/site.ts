/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The site's origin (scheme, host, port), for the pairing line when this
// bay has no public origin of its own.

import siteURL from "@cocalc/database/settings/site-url";

export async function computersSite(): Promise<string> {
  return new URL(await siteURL()).origin;
}
