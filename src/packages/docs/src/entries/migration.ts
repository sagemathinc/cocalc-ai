/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { DocsEntry } from "../types";
import { MIGRATING_FROM_COCALC_COM_BODY } from "../content/migration";

export const MIGRATION_ENTRIES: DocsEntry[] = [
  {
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: MIGRATING_FROM_COCALC_COM_BODY.trim(),
    category: "Account and billing",
    id: "account.migrating-from-cocalc-com",
    lastReviewed: "2026-07-02",
    noActionReason:
      "Migration actions depend on account-specific legacy matches and are opened from account settings or the migration banner.",
    searchKeywords:
      "migration migrate cocalc.com legacy projects billing credit membership restore import account email",
    slug: "account/migrating-from-cocalc-com",
    status: "ready",
    summary:
      "Move legacy cocalc.com billing credit and projects into CoCalc.ai using the same verified email address.",
    title: "Migrating from cocalc.com",
  },
];
