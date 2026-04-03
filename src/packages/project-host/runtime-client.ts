/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getClient as getConatClient } from "@cocalc/conat/client";
import type { Client } from "@cocalc/conat/core/client";

// Project-host feature modules should route through this helper instead of
// importing @cocalc/conat/client directly, so the runtime's Conat choice
// stays local to project-host code.
export function getProjectHostConatClient(): Client {
  return getConatClient().conat();
}
