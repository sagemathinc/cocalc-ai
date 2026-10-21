/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
A board whose edit history cannot be loaded (a stored entry too large to
read, 413) is rebuilt from its saved .board.json by the board's host,
automatically (bounded history plan H1b-4 r3).  The host is the file's only
writer (BoardManager), so the file holds every edit but those not yet saved
to it.  One seeded reset replaces the history with the file's records:

1. The board's run slot, before anything is read (busy otherwise); one
   deadline; the slot is held until everything the run started has settled;
   at most one unresolved reset per board (sync/editor/generic/reset-run.ts).
2. The history's conditions (epoch, revision), captured BEFORE the file is
   read and used unchanged for the reset (CORR-H1B4P-2).  A history already
   reset after the failed open (an epoch greater than the one the persist
   server failed in) is a recovery, by another host or a late reset of this
   one: nothing to reset, the board reopens.
3. The file, read with a bound, and its records, built offline, each one
   measured against what remains of the value budgets before it is added;
   the seed at most 40 MiB.
4. The reset, through the board write service, conditional on exactly the
   conditions of step 2, with a deterministic opId.  Refused as "moved" or
   "epoch": step 2 again (at most 3 rounds), never old bytes under new
   conditions.

A refusal before a reset is sent changes nothing, neither the file nor the
history.  Once a reset is sent, a deadline, a transport timeout or a
disconnect leaves its outcome unknown ("reset-unknown"), never a refusal:
the slot and the gate hold every other run until it settles, and the next
open recognizes a late success by its epoch (step 2).
*/

import { createHash } from "node:crypto";
import type { SyncClient } from "@cocalc/conat/sync-doc/sync-client";
import type { ResetHistoryResult } from "@cocalc/conat/persist/storage";
import {
  isResetBusy,
  RESET_BUSY_DELAY_MS,
} from "@cocalc/conat/persist/reset-busy";
import { BOARD_WRITE_SERVICE } from "@cocalc/conat/persist/board-policy";
import { seedOfValue } from "@cocalc/sync/editor/generic/history-restart";
import {
  DeadlineExpired,
  gateAllowsReset,
  resolveGate,
  setUnresolvedReset,
  startRun,
  withDeadline,
} from "@cocalc/sync/editor/generic/reset-run";
import { jsonMeasureCapped } from "@cocalc/util/json-size";
import {
  BOARD_HOST_BYTE_LIMIT,
  BOARD_HOST_RECORD_LIMIT,
} from "@cocalc/util/board/names";
import {
  BOARD_FILE_RESET_REASON,
  type BoardHistoryCause,
} from "@cocalc/util/board/history-unloadable";
import type { BoardFile, BoardLib } from "./manager";

export const REBUILD_LIMITS = {
  deadlineMs: 40_000,
  fileBytes: BOARD_HOST_BYTE_LIMIT,
  records: BOARD_HOST_RECORD_LIMIT,
  valueBytes: 32 * 1024 * 1024,
  valueWork: 32 * 1024 * 1024,
  seedBytes: 40 * 1024 * 1024,
  rounds: 3,
  gateObserveMs: 10_000,
};

type Refusal = Exclude<BoardHistoryCause, "reset-unknown">;

export type BoardRebuild =
  // rebuilt by this run
  | {
      outcome: "rebuilt";
      history_epoch: number;
      reset: { reason: string; time: number };
      // the same reset (same conditions, same file) had already applied,
      // e.g. from another host: nothing was reset again
      repeated?: boolean;
    }
  // reset after the failed open, by another host or an earlier run of this
  // one: reopen; reset is what that reset recorded
  | {
      outcome: "recovered";
      history_epoch: number;
      reset?: { reason?: string; time?: number };
    }
  // nothing was reset: the file and the history are as they were
  | { outcome: "refused"; cause: Refusal; message: string }
  // a reset was sent and its outcome is not known
  | { outcome: "unknown"; cause: "reset-unknown"; message: string };

export const BOARD_HISTORY_PERSIST = {
  service: BOARD_WRITE_SERVICE,
  persistUser: {},
};

// A result's message: about the board, never its content.
const MESSAGE_MAX = 300;

const BUSY_MESSAGE = "the board's history is already being rebuilt; try again";

class Refused extends Error {
  constructor(
    public cause: Refusal,
    message: string,
  ) {
    super(message);
  }
}

// The board's records as its syncdb's string, from the file's text, capped
// as they are built (step 3).
export function boardSeedValue({
  text,
  lib,
  recordsToString,
  limits = REBUILD_LIMITS,
}: {
  text: string;
  lib: Pick<BoardLib, "cleanDoc" | "formatError" | "toRecords">;
  recordsToString: (records: any[]) => string;
  limits?: Pick<typeof REBUILD_LIMITS, "records" | "valueBytes" | "valueWork">;
}): string {
  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch {
    // (the parser's message quotes the file: the result never carries it)
    throw new Refused("file-invalid", "the saved board is not valid JSON");
  }
  const problem = lib.formatError(doc);
  if (problem) {
    throw new Refused(
      "file-invalid",
      `the saved file is not a board: ${problem}`.slice(0, MESSAGE_MAX),
    );
  }
  const records = lib.toRecords(lib.cleanDoc(doc));
  if (records.length > limits.records) {
    throw new Refused(
      "file-too-large",
      `the board has ${records.length} records, over the ${limits.records} its host edits`,
    );
  }
  let bytes = 0;
  let work = 0;
  for (const record of records) {
    const measured = jsonMeasureCapped(record, {
      max: limits.valueBytes - bytes,
      maxWork: limits.valueWork - work,
    });
    if (measured == null) {
      throw new Refused(
        "file-too-large",
        `the board's records are larger than ${limits.valueBytes} bytes`,
      );
    }
    bytes += measured.bytes + 1;
    work += measured.work;
  }
  return recordsToString(records);
}

export async function rebuildBoardHistory({
  project_id,
  syncPath,
  file,
  lib,
  recordsToString,
  failedEpoch,
  syncClient,
  limits = REBUILD_LIMITS,
  now = Date.now,
}: {
  project_id: string;
  // the board's syncdb path: its history
  syncPath: string;
  file: Pick<BoardFile, "read">;
  lib: Pick<BoardLib, "cleanDoc" | "formatError" | "toRecords">;
  recordsToString: (records: any[]) => string;
  // the epoch the persist server failed to load the history in; undefined if
  // it did not say (an older server): then no reset is taken for a recovery
  failedEpoch?: number;
  syncClient: Pick<SyncClient, "historyResetState" | "resetHistory">;
  // for tests
  limits?: typeof REBUILD_LIMITS;
  now?: () => number;
}): Promise<BoardRebuild> {
  // step 1: the slot, before anything is read
  const run = startRun(syncPath, { deadlineMs: limits.deadlineMs, now });
  if (run == null) {
    return { outcome: "refused", cause: "busy", message: BUSY_MESSAGE };
  }
  const { deadlineAt, track } = run;
  const readState = () =>
    syncClient.historyResetState({
      project_id,
      path: syncPath,
      persist: BOARD_HISTORY_PERSIST,
    });
  let sent = false;
  try {
    if (
      !(await gateAllowsReset({
        key: syncPath,
        readState,
        deadlineAt,
        observeMs: limits.gateObserveMs,
        now,
        track,
      }))
    ) {
      return { outcome: "refused", cause: "busy", message: BUSY_MESSAGE };
    }
    for (let round = 0; round < limits.rounds; round++) {
      // step 2: the conditions, before the file is read
      const state = await withDeadline(deadlineAt, track(readState()), now);
      if (failedEpoch != null && state.epoch > failedEpoch) {
        return {
          outcome: "recovered",
          history_epoch: state.epoch,
          ...(state.reset != null ? { reset: state.reset } : {}),
        };
      }
      const epoch = state.epoch;
      const revision = { seq: state.seq, count: state.count };

      // step 3: the file, then its records, offline
      const read = await withDeadline(
        deadlineAt,
        track(file.read(limits.fileBytes)),
        now,
      );
      if (read == null) {
        throw new Refused("file-missing", "the board's saved file is missing");
      }
      if ("tooLarge" in read) {
        throw new Refused(
          "file-too-large",
          `the board's saved file is larger than ${limits.fileBytes} bytes`,
        );
      }
      if ("refused" in read) {
        throw new Refused("file-invalid", read.refused.slice(0, MESSAGE_MAX));
      }
      const value = boardSeedValue({
        text: read.text,
        lib,
        recordsToString,
        limits,
      });
      const seed = seedOfValue(value);
      if (seed.raw.length > limits.seedBytes) {
        throw new Refused(
          "file-too-large",
          `the rebuilt history's first entry would be larger than ${limits.seedBytes} bytes`,
        );
      }

      // step 4: one reset, under exactly the conditions of step 2
      const opId = [
        BOARD_FILE_RESET_REASON,
        epoch,
        revision.seq,
        revision.count,
        createHash("sha256").update(read.text).digest("hex"),
      ].join(":");
      const remaining = deadlineAt - now();
      if (remaining <= 0) throw new DeadlineExpired();
      if (
        !setUnresolvedReset(syncPath, {
          opId,
          epoch,
          revision,
          observedAt: now(),
        })
      ) {
        throw new Refused("busy", BUSY_MESSAGE);
      }
      const time = now();
      sent = true;
      const reset = track(
        syncClient.resetHistory({
          project_id,
          path: syncPath,
          persist: BOARD_HISTORY_PERSIST,
          // retry another reset's busy only for what remains of the deadline
          busyAttempts: Math.max(
            1,
            Math.floor(remaining / RESET_BUSY_DELAY_MS) - 1,
          ),
          options: {
            ifRevision: revision,
            ifInitEpoch: epoch,
            coveredSeq: 0,
            allowRollback: true,
            archive: true,
            seed,
            reason: BOARD_FILE_RESET_REASON,
            opId,
            settings: {
              history_purged_at: time,
              history_reset: {
                reason: BOARD_FILE_RESET_REASON,
                coverage: "none",
                coveredSeq: 0,
                time,
              },
            },
          } as any,
        }),
      );
      // only this reset's own answer clears the gate, whenever it comes
      reset.then(
        () => resolveGate(syncPath, opId),
        () => resolveGate(syncPath, opId),
      );
      const result: ResetHistoryResult = await withDeadline(
        deadlineAt,
        reset,
        now,
      );
      // answered: whatever follows is known
      sent = false;
      if (result.reset) {
        return {
          outcome: "rebuilt",
          history_epoch: result.history_epoch,
          reset: { reason: BOARD_FILE_RESET_REASON, time },
          ...(result.repeated ? { repeated: true } : {}),
        };
      }
      if (result.refused == "moved" || result.refused == "epoch") {
        // another host or edit got there first: its conditions, again
        continue;
      }
      if (result.refused == "busy") throw new Refused("busy", BUSY_MESSAGE);
      if (result.refused == "trash-pending") {
        throw new Refused(
          "trash-pending",
          "an earlier rebuild of this board's history is still being cleaned up; try again in a minute",
        );
      }
      if (result.refused == "seed-too-large") {
        throw new Refused(
          "file-too-large",
          "the rebuilt history's first entry is too large",
        );
      }
      throw new Refused(
        "failed",
        `the history was not rebuilt (${result.refused})`,
      );
    }
    throw new Refused(
      "failed",
      "the board's history kept changing while it was being rebuilt",
    );
  } catch (err) {
    if (sent) {
      // A busy answer to the last attempt: none of them applied.
      if (isResetBusy(err)) {
        return { outcome: "refused", cause: "busy", message: BUSY_MESSAGE };
      }
      // Sent, and then a deadline, a timeout or a disconnect: it may have
      // applied.  Never a refusal.
      return {
        outcome: "unknown",
        cause: "reset-unknown",
        message:
          "the board's history may already have been rebuilt from its saved file, but no answer came in time",
      };
    }
    if (err instanceof Refused) {
      return { outcome: "refused", cause: err.cause, message: err.message };
    }
    if (err instanceof DeadlineExpired) {
      return {
        outcome: "refused",
        cause: "deadline",
        message: `rebuilding the board's history took more than ${Math.round(limits.deadlineMs / 1000)} seconds; nothing was changed`,
      };
    }
    return {
      outcome: "refused",
      cause: "failed",
      message: `the board's history could not be rebuilt: ${err}`.slice(
        0,
        MESSAGE_MAX,
      ),
    };
  } finally {
    // the slot only once nothing of this run is left
    run.finish();
  }
}
