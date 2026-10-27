/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { normalizeProviderId } from "@cocalc/cloud";
import { getServerSettings } from "@cocalc/database/settings/server-settings";

// Nebius stays enabled for dedicated VMs (project_hosts_nebius_enabled); it
// is offered for project hosts only while that and this further setting are
// both on.
export const NEBIUS_PROJECT_HOSTS_SETTING =
  "project_hosts_nebius_hosts_enabled";

/** Refuses to create a project host on, or switch one to, a provider that is
 * not offered for new project hosts. Existing hosts keep working: their
 * owners can still start, stop, deprovision and delete them. */
export async function assertProjectHostProviderOffered(
  cloud: unknown,
  settings?: Record<string, unknown>,
): Promise<void> {
  if (normalizeProviderId(cloud as any) !== "nebius") return;
  const current = settings ?? (await getServerSettings());
  if (
    current.project_hosts_nebius_enabled === true &&
    current[NEBIUS_PROJECT_HOSTS_SETTING] === true
  ) {
    return;
  }
  throw new Error(
    "Nebius is not offered for project hosts; use a dedicated VM for Nebius GPUs",
  );
}
