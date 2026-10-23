/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Host methods for server code that acts on a host that may live on another
// bay (e.g. a fleet rollout). Each runs on the host's owning bay, exactly as
// the same hub API call would (see @cocalc/conat/hub/api/routes), as the
// account given: here if this bay owns the host, else forwarded there once.

import type * as Hosts from "./hosts";
import type { LroSummary } from "@cocalc/conat/hub/api/lro";
import type { Client } from "@cocalc/conat/core/client";
import { waitForDurableLroCompletion } from "@cocalc/server/lro/wait";
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

const HOST_LRO_POLL_MS = 5_000;

/**
 * Wait for a host operation (e.g. the one upgradeHostSoftware returned) to
 * finish. It lives on the host's bay: its summary is read there through the
 * routed lro.get. The local stream only adds prompt progress when that bay
 * is this one.
 */
export async function waitForHostLro({
  account_id,
  op,
  client,
  timeout_ms,
}: {
  account_id: string;
  op: { op_id: string; scope_type: "host"; scope_id: string };
  client: Client;
  timeout_ms: number;
}): Promise<LroSummary> {
  return await waitForDurableLroCompletion({
    op_id: op.op_id,
    scope_type: op.scope_type,
    scope_id: op.scope_id,
    client,
    timeout_ms,
    // Each read of a remote operation is a forwarded call: not every second.
    poll_ms: HOST_LRO_POLL_MS,
    getSummary: async () =>
      await executeHubApiCall({
        name: "lro.get",
        args: [
          {
            op_id: op.op_id,
            scope_type: op.scope_type,
            scope_id: op.scope_id,
          },
        ],
        account_id,
      }),
  });
}
