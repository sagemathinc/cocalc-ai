/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// STAGING FAULT TEST ONLY (finding 028 B-3a, DESIGN §7): a persist server
// with the fault-phase hook installed.  Built only by `pnpm build:fault-test`
// into dist-fault-test/; never part of a production bundle.

import { conat } from "@cocalc/backend/conat";
import { installPersistExitGuard } from "@cocalc/backend/conat/persist";
import { server } from "@cocalc/conat/persist/server";
import { installFaultPhaseHook } from "./fault-phase-hook";

async function main() {
  installFaultPhaseHook();
  installPersistExitGuard();
  const client = await conat();
  server({ client });
}

main();
