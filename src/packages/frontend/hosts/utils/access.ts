/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Host } from "@cocalc/conat/hub/api/hosts";

export function canManageHostLifecycle(host?: Pick<Host, "access_role">) {
  return host?.access_role === "owner" || host?.access_role === "admin";
}
