/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveHostBay } from "@cocalc/server/inter-bay/directory";

// A method routed to the host's owning bay (see
// @cocalc/conat/hub/api/routes) refuses to run anywhere else: a stale route,
// which the caller retries after re-resolving the owner.
export async function assertHostOwnedHere(host_id: string): Promise<void> {
  const owner = `${(await resolveHostBay(host_id))?.bay_id ?? ""}`.trim();
  if (owner && owner !== getConfiguredBayId()) {
    throw Object.assign(
      new Error(
        `stale route: host ${host_id} is owned by ${owner}, not ${getConfiguredBayId()}; retry`,
      ),
      { code: 409 },
    );
  }
}
