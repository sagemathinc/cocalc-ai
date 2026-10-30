/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// The authorization record of a forwarded GPU call that may decrypt the key
// (5d-2c), made on the key owner's home bay by the inter-bay service, from
// the forwarded, verified principal (the calling bay authenticated it), with
// the method's fixed purpose. Anything a caller put in key_use is replaced.

import {
  admitAgentKeyUse,
  admitProjectKeyUse,
  admitUserKeyUse,
  isGpuKeyHomeBay,
  type GpuKeyUse,
  type GpuKeyUsePurpose,
} from "@cocalc/server/gpu/key-use";
import { isValidUUID } from "@cocalc/util/misc";

export async function forwardedGpuKeyUse(
  opts: any,
  purpose: GpuKeyUsePurpose,
): Promise<GpuKeyUse | undefined> {
  const account_id = opts?.account_id;
  if (typeof account_id !== "string" || !isValidUUID(account_id)) {
    return undefined;
  }
  if (!(await isGpuKeyHomeBay(account_id))) return undefined;
  // a launch carries the agent's principal, other calls its scope
  const agent = opts?.agent?.principal ?? opts?.agent;
  if (agent) {
    if (agent.account_id != null && agent.account_id !== account_id) {
      return undefined;
    }
    return await admitAgentKeyUse({
      principal: {
        account_id,
        project_id: `${agent.project_id ?? ""}`,
        agent_id: `${agent.agent_id ?? ""}`,
        run_id: agent.run_id == null ? undefined : `${agent.run_id}`,
      },
      purpose,
    });
  }
  return await admitUserKeyUse({ account_id, purpose });
}

// A launch under a project funding approval, at the funder's home bay's
// boundary (PROJECT_FUNDING.md §5): the project's current owning bay sent
// it (verified), the key use is made here, bound to exactly the approval
// and layer it names, and admission pins that layer. Called by the
// inter-bay service, and in process when the project's bay is this bay.
export async function projectFundedLaunchAtHome(
  req: import("@cocalc/util/gpu/project-funding").ProjectFundingLaunchRequest,
): Promise<import("@cocalc/util/gpu/types").GpuPodSummary> {
  const { verifyProjectFundedLaunch } =
    await import("@cocalc/server/gpu/project-funding");
  const v = await verifyProjectFundedLaunch(req);
  if (!(await isGpuKeyHomeBay(v.funder_account_id))) {
    throw Error("A funded launch must reach the funder's home bay.");
  }
  const key_use = await admitProjectKeyUse({
    key_owner_account_id: v.funder_account_id,
    purpose: "launch",
    binding: v.binding,
  });
  const { launchGpuPodLocal } = await import("@cocalc/server/gpu/pods");
  return await launchGpuPodLocal({
    account_id: v.funder_account_id,
    project_id: v.project_id,
    spec: req.spec,
    key_use,
    funding: v.funding,
  });
}
