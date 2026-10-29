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
