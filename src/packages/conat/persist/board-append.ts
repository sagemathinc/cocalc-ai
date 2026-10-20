/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The board write service's append rule (board-history.ts, BoardAppendCheck),
applied to a stored stream: every patch the service stores for a board
extends the stream's one chain. persist/server.ts calls appendCheck() and
then commitAppend() in the same synchronous step as the store, after the
fence check, so nothing can come between the check and the write.

The head is read from the stream's newest stored patch the first time, and
again whenever the stream has moved since (its newest seq isn't the one the
head was read at, e.g. after a delete); after each store it is the newest
patch just stored.
*/

import { ConatError } from "@cocalc/conat/core/client";
import { decode } from "@cocalc/conat/core/codec";
import { BoardAppendCheck } from "./board-history";

// What this needs of a stored stream (storage.ts).
export interface AppendStream {
  seqBounds(): { newest_retained_seq?: number };
  sqlite(statement: string, params?: any[]): any[];
  get(opts: {
    seq: number;
    key: undefined;
  }): { encoding: any; raw: Buffer } | undefined;
}

// How far back from the newest message the head is looked for: a stream's
// newest messages are patches, with a snapshot now and then.
const HEAD_SEARCH = 64;

const checks = new WeakMap<object, BoardAppendCheck>();

function newestSeq(stream: AppendStream): number {
  return stream.seqBounds().newest_retained_seq ?? 0;
}

function readHead(stream: AppendStream): BoardAppendCheck {
  const seq = newestSeq(stream);
  const rows = stream.sqlite(
    "SELECT seq FROM messages ORDER BY seq DESC LIMIT ?",
    [HEAD_SEARCH],
  ) as { seq: number }[];
  for (const { seq: s } of rows) {
    const m = stream.get({ seq: Number(s), key: undefined });
    if (m == null) continue;
    let value: any;
    try {
      value = decode({ encoding: m.encoding, data: m.raw });
    } catch {
      continue;
    }
    if (value?.is_snapshot === true) continue;
    if (typeof value?.time !== "string" || !Array.isArray(value?.parents)) {
      continue;
    }
    return new BoardAppendCheck({
      head: value.time,
      headParents: value.parents,
      seq,
    });
  }
  if (rows.length > 0) {
    // Messages, but no patch among the newest: the head can't be known
    // cheaply, so nothing is appended (fail closed).
    throw new ConatError("this board's history has no recent patch to follow", {
      code: "branch",
    });
  }
  return new BoardAppendCheck({ seq });
}

function checkFor(stream: AppendStream): BoardAppendCheck {
  let check = checks.get(stream);
  if (check == null || check.atSeq !== newestSeq(stream)) {
    check = readHead(stream);
    checks.set(stream, check);
  }
  return check;
}

// The records a set or setMany request would store, decoded.
export function requestRecords(
  request: { cmd?: unknown },
  mesg: { raw?: Buffer; encoding?: any; data?: any },
): unknown[] | undefined {
  const record = (encoding: any, data: Buffer | undefined) => {
    try {
      return decode({ encoding, data });
    } catch (err) {
      throw new ConatError(`not a board patch record: ${err}`.slice(0, 300), {
        code: "branch",
      });
    }
  };
  if (request.cmd === "set") {
    return [record(mesg.encoding, mesg.raw)];
  }
  if (request.cmd === "setMany") {
    return (mesg.data as { messageData: { raw: Buffer; encoding: any } }[]).map(
      ({ messageData }) => record(messageData.encoding, messageData.raw),
    );
  }
  return undefined;
}

// Throws "branch" unless storing these records keeps the history one chain.
// Returns what to commit after the store.
export function appendCheck(
  stream: AppendStream,
  records: unknown[],
): { check: BoardAppendCheck; next: ReturnType<BoardAppendCheck["check"]> } {
  const check = checkFor(stream);
  return { check, next: check.check(records) };
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
