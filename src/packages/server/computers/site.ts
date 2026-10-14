/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The site identity computers are paired with: the origin of the site URL
// (scheme, host, port), normalized exactly as the protocol requires.

import siteURL from "@cocalc/database/settings/site-url";
import { site } from "@cocalc/util/computers/protocol";

export async function computersSite(): Promise<string> {
  return site(new URL(await siteURL()).origin);
}
