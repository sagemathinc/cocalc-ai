/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getClient as getConatClient } from "@cocalc/conat/client";
import type { Client } from "@cocalc/conat/core/client";

export function getProjectConatClient(): Client {
  return getConatClient().conat();
}
