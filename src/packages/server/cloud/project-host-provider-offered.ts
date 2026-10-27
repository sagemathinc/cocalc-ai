/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { normalizeProviderId } from "@cocalc/cloud";
import { getServerSettings } from "@cocalc/database/settings/server-settings";

// Nebius stays enabled for dedicated VMs (project_hosts_nebius_enabled); it
// is offered for project hosts only while this further setting is on.
export const NEBIUS_PROJECT_HOSTS_SETTING =
  "project_hosts_nebius_hosts_enabled";

/** Refuses to create, start or switch a project host onto a provider that
 * is not offered for project hosts. Stopping, deprovisioning and deleting an
 * existing host stay allowed, so nothing is stranded. */
export async function assertProjectHostProviderOffered(
  cloud: unknown,
  settings?: Record<string, unknown>,
): Promise<void> {
  if (normalizeProviderId(cloud as any) !== "nebius") return;
  const current = settings ?? (await getServerSettings());
  if (current[NEBIUS_PROJECT_HOSTS_SETTING] === true) return;
  throw new Error(
    "Nebius is not offered for project hosts; use a dedicated VM for Nebius GPUs",
  );
}
