/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
G1 on open (A2b design, section 8c): before a board's syncdb is opened (and
so before patchflow's Session.init reconstructs any value), its patch
stream's raw records are read, streamed and bounded, and checked by
BoardHistoryCheck (conat/persist/board-history.ts). Only a history that is a
clean cut plus a bounded linear suffix is opened in the host's process; any
other board is quarantined: not opened, not edited, its file and its stream
left exactly as they are, until an isolated recovery (A4) repairs it.

The check reads through the board write service, which serves reads without
the fence. The stream's inventory (its stored size and record count) is read
first, so an oversized history is refused before any record is read; then
the records, a page at a time, each one's stored size checked before it is
decoded, stopping at the first refusal.
*/

import type { Client as ConatClient } from "@cocalc/conat/core/client";
import { decode } from "@cocalc/conat/core/codec";
import {
  BOARD_HISTORY_LIMITS,
  type BoardHistoryLimits,
  BoardHistoryCheck,
  type HistoryVerdict,
} from "@cocalc/conat/persist/board-history";
import { BOARD_WRITE_SERVICE } from "@cocalc/conat/persist/board-policy";
import { stream as persistStream } from "@cocalc/conat/persist/client";
import { storagePath } from "@cocalc/conat/sync/core-stream";
import { patchesStreamName } from "@cocalc/conat/sync/synctable-stream";
import { boardSyncdbPath } from "@cocalc/util/board/names";

// A board whose history may not be opened in the host's process.
export class BoardQuarantined extends Error {
  readonly verdict: Exclude<HistoryVerdict, { ok: true }>;
  constructor(verdict: Exclude<HistoryVerdict, { ok: true }>) {
    super(`this board's history can't be opened here: ${verdict.message}`);
    this.verdict = verdict;
  }
}

export async function checkBoardHistory({
  client,
  project_id,
  path,
  limits = BOARD_HISTORY_LIMITS,
  timeout = 30_000,
}: {
  client: ConatClient;
  project_id: string;
  path: string;
  limits?: BoardHistoryLimits;
  timeout?: number;
}): Promise<HistoryVerdict> {
  const stream = persistStream({
    client,
    user: {},
    storage: {
      path: storagePath({
        project_id,
        name: patchesStreamName({ path: boardSyncdbPath(path) }),
      }),
    },
    service: BOARD_WRITE_SERVICE,
    noCache: true,
  });
  try {
    const check = new BoardHistoryCheck(limits);
    const inventory = await stream.inventory(timeout);
    if (inventory.count > limits.records) {
      return {
        ok: false,
        reason: "too-large",
        message: `a history of ${inventory.count} records, over the ${limits.records} a board's history may hold`,
      };
    }
    // (Stored bytes may be compressed: only a lower bound on the records'.)
    if (inventory.bytes > limits.totalBytes) {
      return {
        ok: false,
        reason: "too-large",
        message: `a history of ${inventory.bytes} bytes, over the ${limits.totalBytes} a board's history may hold`,
      };
    }
    for await (const page of stream.getAllIter({ timeout })) {
      for (const message of page) {
        const bytes = message.raw?.length ?? 0;
        const sized = check.checkSize(bytes);
        if (sized) return sized;
        let value: unknown;
        try {
          value = decode({ encoding: message.encoding, data: message.raw });
        } catch (err) {
          return {
            ok: false,
            reason: "invalid",
            message: `a record that can't be decoded: ${err}`.slice(0, 300),
          };
        }
        const stop = check.add(value, bytes);
        if (stop) return stop;
      }
    }
    return check.finish();
  } finally {
    stream.close();
  }
}

// Throws BoardQuarantined unless the board's history may be opened here.
export async function assertBoardHistoryOpenable(
  opts: Parameters<typeof checkBoardHistory>[0],
): Promise<Extract<HistoryVerdict, { ok: true }>> {
  const verdict = await checkBoardHistory(opts);
  if (!verdict.ok) throw new BoardQuarantined(verdict);
  return verdict;
}
