/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import {
  claimCollaborationRevisionHint,
  settleCollaborationRevisionHint,
} from "@cocalc/database/postgres/collaborators/collaborators-revision-interest";
import { createInterBayCollaboratorsClient } from "@cocalc/conat/inter-bay/collaborators";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getServerSettings } from "@cocalc/database/settings/server-settings";

/** One explicit internal attempt; not a timer or a public endpoint. A missing
 * receiver or an unknown RPC outcome retains the durable claim until expiry.
 */
export async function dispatchCollaborationRevisionHint(request: {
  project_id: string;
  home_bay_id: string;
  lease_id: string;
}) {
  if (
    process.env.COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE !== "1" ||
    process.env.COCALC_PEOPLE_DEMAND_PROTOTYPE !== "1" ||
    !(await getServerSettings()).collaborators_enabled
  )
    throw Error("revision dispatch disabled");
  const owning_bay_id = getConfiguredBayId();
  const authority = { owning_bay_id };
  const claim = await claimCollaborationRevisionHint(request, authority);
  if (!claim) return { state: "deferred" as const };
  const receiver = createInterBayCollaboratorsClient({
    client: getInterBayFabricClient(),
    bay_id: claim.home_bay_id,
  });
  const result = await receiver.receiveRevisionWakeup({
    project_id: claim.project_id,
    owner_bay_id: owning_bay_id,
    lease_id: claim.lease_id,
    route: { bay_id: claim.home_bay_id },
  });
  if (result.accepted !== true) return { state: "deferred" as const };
  const settled = await settleCollaborationRevisionHint(claim, authority);
  return { state: settled ? ("acknowledged" as const) : ("deferred" as const) };
}
