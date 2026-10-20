/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The board write service's append rule (board-history.ts, BoardAppendCheck),
applied to a stored stream: every record the service stores for a board
keeps its history one chain, as PatchGraph reads it. persist/server.ts calls
appendCheck() and then commitAppend() in the same synchronous step as the
store, after the fence check, so nothing can come between the check and the
write.

The stored graph (every patch's time and parents) is read from the stream
the first time, and again whenever the stream has moved since (its newest
seq isn't the one the graph was read at, e.g. after a delete). Reading it is
bounded as the open check is: at most BOARD_HISTORY_LIMITS.records records,
each within the stream's record cap.
*/

import { createHash } from "node:crypto";
import { ConatError } from "@cocalc/conat/core/client";
import { decode } from "@cocalc/conat/core/codec";
import {
  BOARD_HISTORY_LIMITS,
  BoardAppendCheck,
  type AppendRecord,
} from "./board-history";

// What this needs of a stored stream (storage.ts).
export interface AppendStream {
  seqBounds(): { newest_retained_seq?: number };
  getAll(): Iterable<{ encoding: any; raw: Buffer; key?: string }>;
}

// A record's identity: its encoding and exact bytes, as stored.
function digestOf(encoding: unknown, raw: Buffer | undefined): string {
  return createHash("sha256")
    .update(`${encoding}\0`)
    .update(raw ?? Buffer.alloc(0))
    .digest("hex");
}

const checks = new WeakMap<object, BoardAppendCheck>();

function newestSeq(stream: AppendStream): number {
  return stream.seqBounds().newest_retained_seq ?? 0;
}

function* records(stream: AppendStream): Generator<AppendRecord> {
  let n = 0;
  for (const m of stream.getAll()) {
    if (++n > BOARD_HISTORY_LIMITS.records) {
      // Unreadable as a board's history: nothing may be appended.
      yield { value: { invalid: "over the record limit" }, digest: "" };
      return;
    }
    let value: unknown;
    try {
      value = decode({ encoding: m.encoding, data: m.raw });
    } catch {
      value = undefined;
    }
    yield {
      value,
      digest: digestOf(m.encoding, m.raw),
      key: m.key ?? undefined,
    };
  }
}

function readGraph(stream: AppendStream): BoardAppendCheck {
  const seq = newestSeq(stream);
  try {
    return BoardAppendCheck.fromRecords(records(stream), seq);
  } catch (err) {
    // E.g. a stored record over the record cap: nothing may be appended.
    return new BoardAppendCheck({
      seq,
      broken: `its stored history can't be read: ${err}`.slice(0, 300),
    });
  }
}

function checkFor(stream: AppendStream): BoardAppendCheck {
  let check = checks.get(stream);
  if (check == null || check.atSeq !== newestSeq(stream)) {
    check = readGraph(stream);
    checks.set(stream, check);
  }
  return check;
}

// The records a set or setMany request would store: decoded, with the
// digest of the bytes it would store and the storage key it names.
export function requestRecords(
  request: { cmd?: unknown; key?: unknown },
  mesg: { raw?: Buffer; encoding?: any; data?: any },
): AppendRecord[] | undefined {
  const record = (
    encoding: any,
    data: Buffer | undefined,
    key: unknown,
  ): AppendRecord => {
    let value: unknown;
    try {
      value = decode({ encoding, data });
    } catch (err) {
      throw new ConatError(`not a board patch record: ${err}`.slice(0, 300), {
        code: "branch",
      });
    }
    return {
      value,
      digest: digestOf(encoding, data),
      key: key == null ? undefined : `${key}`,
    };
  };
  if (request.cmd === "set") {
    return [record(mesg.encoding, mesg.raw, request.key)];
  }
  if (request.cmd === "setMany") {
    return (
      mesg.data as {
        key?: unknown;
        messageData: { raw: Buffer; encoding: any };
      }[]
    ).map(({ key, messageData }) =>
      record(messageData.encoding, messageData.raw, key),
    );
  }
  return undefined;
}

// Throws "branch" unless storing these records keeps the history one chain.
// Returns what to commit after the store.
export function appendCheck(
  stream: AppendStream,
  records: AppendRecord[],
): { check: BoardAppendCheck; next: ReturnType<BoardAppendCheck["check"]> } {
  const check = checkFor(stream);
  return { check, next: check.check(records) };
}

// For tests: the graph's head as the service sees it.
export function appendHead(stream: AppendStream): string | undefined {
  return checkFor(stream).currentHead;
}

// After a successful store: the new head, at the stream's newest seq.
export function commitAppend(
  stream: AppendStream,
  { check, next }: ReturnType<typeof appendCheck>,
): void {
  check.commit(next, newestSeq(stream));
}

// After anything else that changes the stream (a delete, a reset): the head
// is read again before the next append.
export function forgetAppendHead(stream: AppendStream): void {
  checks.delete(stream);
}
