/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getServerSettings } from "@cocalc/database/settings/server-settings";

export async function isLegacyMigrationEnabled(): Promise<boolean> {
  const settings = await getServerSettings();
  return settings.legacy_migration_enabled === true;
}

export async function assertLegacyMigrationEnabled(): Promise<void> {
  if (!(await isLegacyMigrationEnabled())) {
    throw new Error("legacy cocalc.com migration is not enabled on this site");
  }
}
