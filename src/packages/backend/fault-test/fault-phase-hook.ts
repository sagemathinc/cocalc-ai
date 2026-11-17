/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
STAGING FAULT TEST ONLY (finding 028 B-3a, DESIGN v1.21 §7).  NEVER imported
by production code: this directory is excluded from the backend build and
from the package's files, and a release gate (backend/conat/test/persist/
durable-fault-hook-gate.test.ts) fails if any production source imports it
or any production build output contains its marker.  Production code has only a no-op phase
callback (storage.ts setFaultPhaseCallback) with no reset capability.

The staging fault-test build (`pnpm build:fault-test` in backend: its own
tsconfig and output dir, dist-fault-test/; entry conat-persist-fault-test)
installs it.  When the configured phase is reached, it
appends one line (phase, pid, time) to the signal file and fsyncs it, so the
external driver on another machine can fire the hard reset (GCE `reset`, no
ACPI grace), then holds the main thread for the configured time, so the
reset lands inside the phase:
  F1  "commit"        right before a batch's COMMIT (a large batch keeps the
                      COMMIT's write+sync window open), and
      "acked"         after COMMIT returned, before the acks leave;
  F2  "checkpoint"    right before an explicit checkpoint copies the WAL;
  F3  "after-restart" the first batch after a completed checkpoint (a WAL
                      restart: new salts, before its covering sync);
  F4  "close"         right before a final close (the WAL delete/re-create).
Configuration (environment of the fault-test build only):
  COCALC_028_FAULT_PHASE        one of the phases above
  COCALC_028_FAULT_SIGNAL_FILE  the file the driver watches
  COCALC_028_FAULT_HOLD_MS      how long to hold (default 30000)
  COCALC_028_FAULT_EVERY        signal every Nth occurrence (default 1)
*/

import { appendFileSync, closeSync, fsyncSync, openSync } from "node:fs";
import {
  setFaultPhaseCallback,
  type FaultPhase,
} from "@cocalc/conat/persist/storage";

// The unique marker the release gate greps production bundles for.
export const FAULT_PHASE_HOOK_MARKER = "COCALC_028_STAGING_FAULT_PHASE_HOOK_d41f";

const PHASES: FaultPhase[] = [
  "commit",
  "acked",
  "checkpoint",
  "after-restart",
  "close",
];

export function installFaultPhaseHook(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const phase = env.COCALC_028_FAULT_PHASE as FaultPhase;
  const signalFile = env.COCALC_028_FAULT_SIGNAL_FILE;
  if (!PHASES.includes(phase) || !signalFile) {
    throw Error(
      `${FAULT_PHASE_HOOK_MARKER}: COCALC_028_FAULT_PHASE (one of ${PHASES.join(", ")}) and COCALC_028_FAULT_SIGNAL_FILE are required`,
    );
  }
  const holdMs = Math.max(0, Number(env.COCALC_028_FAULT_HOLD_MS ?? 30000));
  const every = Math.max(1, Math.floor(Number(env.COCALC_028_FAULT_EVERY ?? 1)));
  let seen = 0;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  setFaultPhaseCallback((reached, info) => {
    if (reached !== phase) return;
    seen += 1;
    if (seen % every !== 0) return;
    appendFileSync(
      signalFile,
      `${JSON.stringify({ marker: FAULT_PHASE_HOOK_MARKER, phase, pid: process.pid, time: new Date().toISOString(), ...info })}\n`,
    );
    const fd = openSync(signalFile, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // hold the main thread inside the phase until the reset lands
    Atomics.wait(sleeper, 0, 0, holdMs);
  });
}
