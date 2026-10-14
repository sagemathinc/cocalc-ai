/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The one-line way to connect a computer (see server/cli-setup): install or
// upgrade cocalc if needed, then `cocalc computer connect <pairing line>`.

import {
  SetupActionError,
  type SetupPlan,
} from "@cocalc/server/cli-setup/setup-script";
import { pairingUrl } from "./routing";
import { COMPUTERS_DISABLED, computersEnabled } from "./enabled";

export const REQUEST_ID = /^R-[0-9A-HJ-NP-Z]{10}$/;

/** The pairing line comes from this (home) bay, never from the request. */
export async function computerConnectPlan(
  request_id: string,
): Promise<SetupPlan> {
  if (!(await computersEnabled())) {
    throw new SetupActionError(COMPUTERS_DISABLED);
  }
  if (!REQUEST_ID.test(request_id)) {
    throw new SetupActionError("that isn't a pairing request");
  }
  return {
    title: `connect this computer (${request_id})`,
    probe: ["computer", "connect"],
    steps: [{ args: ["computer", "connect", await pairingUrl(request_id)] }],
  };
}
