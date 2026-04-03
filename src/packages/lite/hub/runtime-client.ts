/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { conat } from "@cocalc/backend/conat";
import type { Client } from "@cocalc/conat/core/client";

// Lite feature modules should route through this helper instead of importing
// @cocalc/conat/client directly, so the runtime's Conat choice stays local.
export function getLiteConatClient(): Client {
  return conat();
}
