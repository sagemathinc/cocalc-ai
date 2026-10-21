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
  // What a strict-msgID set of this message would do (storage.ts).
  msgIDOutcome(
    msgID: string | undefined,
    encoding: any,
    raw: Buffer,
  ): "new" | "duplicate" | "conflict";
}

// A record's identity: its encoding and exact bytes, as stored.
export function digestOf(encoding: unknown, raw: Buffer | undefined): string {
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
      yield {
        value: { invalid: "over the record limit" },
        digest: "",
        bytes: 0,
      };
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
      bytes: m.raw?.length ?? 0,
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
// digest of the bytes it would store, the storage key it names, and whether
// storage will write it at all: a record whose msgID is stored with exactly
// this record is a duplicate (a no-op); one whose msgID is stored with
// another record is refused here ("msgid-conflict"), as storage would refuse
// it. Resolved against the stream in the same synchronous step as the check
// and the store (server.ts), so the append check projects exactly what
// storage writes (CORR-956-1).
export function requestRecords(
  request: { cmd?: unknown; key?: unknown; msgID?: unknown },
  mesg: { raw?: Buffer; encoding?: any; data?: any },
  stream?: Pick<AppendStream, "msgIDOutcome">,
): AppendRecord[] | undefined {
  // msgIDs earlier in this request that storage will write: a later record
  // with one is a duplicate of it, or a conflict (storage's setMany does
  // the same).
  const inRequest = new Map<string, { encoding: any; data: Buffer }>();
  const record = (
    encoding: any,
    data: Buffer | undefined,
    key: unknown,
    msgID: unknown,
  ): AppendRecord => {
    // A board record's msgID is a string, or none (astra CORR9561: storage
    // deduplicates any msgID it is given, so a number would slip past the
    // prediction below). Anything else is refused before storage.
    if (msgID != null && typeof msgID !== "string") {
      throw new ConatError(
        `a board record's msgID must be a string, not ${typeof msgID}`,
        { code: "branch" },
      );
    }
    const bytes = data ?? Buffer.alloc(0);
    let outcome =
      stream == null || typeof msgID !== "string"
        ? "new"
        : stream.msgIDOutcome(msgID, encoding, bytes);
    if (outcome === "new" && stream != null && typeof msgID === "string") {
      const earlier = inRequest.get(msgID);
      if (earlier == null) {
        inRequest.set(msgID, { encoding, data: bytes });
      } else {
        outcome =
          earlier.encoding === encoding &&
          Buffer.compare(earlier.data, bytes) === 0
            ? "duplicate"
            : "conflict";
      }
    }
    if (outcome === "conflict") {
      throw new ConatError(
        `a different message with msgID ${msgID}, which is already stored`,
        { code: "msgid-conflict" },
      );
    }
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
      bytes: data?.length ?? 0,
      key: key == null ? undefined : `${key}`,
      ...(outcome === "duplicate" ? { duplicate: true } : {}),
    };
  };
  if (request.cmd === "set") {
    return [record(mesg.encoding, mesg.raw, request.key, request.msgID)];
  }
  if (request.cmd === "setMany") {
    return (
      mesg.data as {
        key?: unknown;
        msgID?: unknown;
        messageData: { raw: Buffer; encoding: any };
      }[]
    ).map(({ key, msgID, messageData }) =>
      record(messageData.encoding, messageData.raw, key, msgID),
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

// After a successful store: the new head, at the stream's newest seq, if
// storage wrote exactly what the check projected (each record it was to
// write got a seq the graph wasn't read at; each duplicate got its stored
// record's seq, nothing written). Otherwise (an error, any surprise) the
// graph is read from the stream again before the next append, so the cache
// never differs from what the stream holds. That read is bounded by the open
// check's caps and stops at the first refusal; it is repeated after each
// such store, and after any delete or reset.
export function commitAppend(
  stream: AppendStream,
  { check, next }: ReturnType<typeof appendCheck>,
  results: { seq: number }[],
): void {
  // (A duplicate of a record earlier in the same batch gets that record's
  // new seq.)
  const writtenSeqs = new Set(
    next.written.flatMap((written, i) =>
      written && results[i]?.seq != null ? [results[i].seq] : [],
    ),
  );
  const asProjected =
    results.length === next.written.length &&
    next.written.every((written, i) => {
      const seq = results[i]?.seq;
      if (seq == null) return false;
      return written
        ? seq > check.atSeq
        : seq <= check.atSeq || writtenSeqs.has(seq);
    });
  if (asProjected) {
    check.commit(next, newestSeq(stream));
  } else {
    checks.delete(stream);
  }
}

// After anything else that changes the stream (a delete, a reset): the head
// is read again before the next append.
export function forgetAppendHead(stream: AppendStream): void {
  checks.delete(stream);
}
