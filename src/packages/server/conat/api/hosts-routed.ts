/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Host methods for server code that acts on a host that may live on another
// bay (e.g. a fleet rollout). Each runs on the host's owning bay, exactly as
// the same hub API call would (see @cocalc/conat/hub/api/routes), as the
// account given: here if this bay owns the host, else forwarded there once.

import type * as Hosts from "./hosts";
import { executeHubApiCall } from "./edge-routing";

type Routed =
  | "getHostRuntimeDeploymentStatus"
  | "rolloutHostManagedComponents"
  | "upgradeHostSoftware";

async function onHostBay<K extends Routed>(
  name: K,
  opts: Parameters<(typeof Hosts)[K]>[0],
): Promise<Awaited<ReturnType<(typeof Hosts)[K]>>> {
  return await executeHubApiCall({
    name: `hosts.${name}`,
    args: [opts],
    account_id: opts.account_id,
  });
}

export const getHostRuntimeDeploymentStatus = (
  opts: Parameters<typeof Hosts.getHostRuntimeDeploymentStatus>[0],
) => onHostBay("getHostRuntimeDeploymentStatus", opts);

export const rolloutHostManagedComponents = (
  opts: Parameters<typeof Hosts.rolloutHostManagedComponents>[0],
) => onHostBay("rolloutHostManagedComponents", opts);

export const upgradeHostSoftware = (
  opts: Parameters<typeof Hosts.upgradeHostSoftware>[0],
) => onHostBay("upgradeHostSoftware", opts);
