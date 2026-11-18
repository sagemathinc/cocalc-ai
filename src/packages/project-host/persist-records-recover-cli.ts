/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// `persist-records-recover --base B --state-dir S [--apply]` (028 ALT-D2,
// ops0's S4 ruling; B and S the persist's diag records_base and
// records_state_dir, compared exactly): the
// operator recovery after a failed set-up of the persist's records root
// (backend/conat/persist-records-recovery.md).  It is a command of this
// entry (main.ts), so it ships in every project-host artifact, and the bay
// persist runs the same entry: on a project host
// `/opt/cocalc/project-host/bin/project-host persist-records-recover`, on a
// bay `"$COCALC_BAY_NODE_BIN" "$COCALC_BAY_PROJECT_HOST_MAIN" persist-records-recover`.
// The environment is the daemon's (its env files + the inherited env), so
// the paths are the persist's own.

import { baseDaemonEnv } from "./daemon";
import { persistStateDirFor } from "@cocalc/backend/conat/persist-durability";
import {
  runPersistRecordsRecoverCli,
  writeReportAndExit,
} from "@cocalc/backend/conat/persist-records-recover";

export const PERSIST_RECORDS_RECOVER_COMMAND = "persist-records-recover";

export function runPersistRecordsRecoverCommand(
  argv: string[],
  write: (s: string) => void = (s) => process.stdout.write(s),
): number {
  let env: Record<string, string>;
  try {
    env = baseDaemonEnv();
  } catch (err) {
    write(JSON.stringify({ ok: false, stop: `environment: ${err}` }, null, 2) + "\n");
    return 2;
  }
  const { code, output } = runPersistRecordsRecoverCli(argv, env, persistStateDirFor(env));
  write(output);
  return code;
}

// main.ts: the whole command; the process ends when the report is written
export function mainPersistRecordsRecover(argv: string[]): void {
  let out = "";
  const code = runPersistRecordsRecoverCommand(argv, (s) => (out += s));
  writeReportAndExit(out, code);
}
