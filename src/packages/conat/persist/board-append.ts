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
  snapshotBody,
  type AppendRecord,
} from "./board-history";
import { isJsonObjectLinesAsync } from "./json-scan";

// What this needs of a stored stream (storage.ts).
export interface AppendStream {
  seqBounds(): { newest_retained_seq?: number };
  getAll(): Iterable<{
    encoding: any;
    raw: Buffer;
    key?: string;
    headers?: unknown;
  }>;
  // What a strict-msgID set of this message would do (storage.ts).
  msgIDOutcome(
    msgID: string | undefined,
    encoding: any,
    raw: Buffer,
  ): "new" | "duplicate" | "conflict";
}

// A record's identity: its encoding and exact bytes, as stored.
// A record's footprint as stored: its bytes, its headers' JSON and its key
// (codex 4332730147: headers count toward a history's bounds, as the
// stored size does). The append and open checks both count this.
export function storedBytes(
  raw: Buffer | undefined,
  headers?: unknown,
  key?: unknown,
): number {
  return (
    (raw?.length ?? 0) +
    (headers == null ? 0 : Buffer.byteLength(JSON.stringify(headers))) +
    (key == null ? 0 : Buffer.byteLength(`${key}`))
  );
}

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
      bytes: storedBytes(m.raw, m.headers, m.key),
      key: m.key ?? undefined,
    };
  }
}

function readGraph(stream: AppendStream): BoardAppendCheck {
  return graphOf(records(stream), newestSeq(stream));
}

function graphOf(list: Iterable<AppendRecord>, seq: number): BoardAppendCheck {
  try {
    return BoardAppendCheck.fromRecords(list, seq);
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
// prepared (prepareRequest): the request's records already decoded and
// their snapshot bodies scanned, before the synchronous step.
export function requestRecords(
  request: { cmd?: unknown; key?: unknown; msgID?: unknown; headers?: unknown },
  mesg: { raw?: Buffer; encoding?: any; data?: any },
  stream?: Pick<AppendStream, "msgIDOutcome">,
  prepared?: PreparedRequest,
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
    headers: unknown,
    index: number,
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
    // (Prepared from exactly these bytes, or decoded now.)
    const entry = prepared?.[index];
    const ready =
      entry != null && entry.data === data && entry.encoding === encoding
        ? entry
        : undefined;
    let value: unknown;
    if (ready != null) {
      value = ready.value;
    } else {
      try {
        value = decode({ encoding, data });
      } catch (err) {
        throw new ConatError(`not a board patch record: ${err}`.slice(0, 300), {
          code: "branch",
        });
      }
    }
    return {
      value,
      digest: digestOf(encoding, data),
      bytes: storedBytes(data, headers, key),
      key: key == null ? undefined : `${key}`,
      ...(outcome === "duplicate" ? { duplicate: true } : {}),
      ...(ready?.document != null ? { document: ready.document } : {}),
    };
  };
  if (request.cmd === "set") {
    return [
      record(
        mesg.encoding,
        mesg.raw,
        request.key,
        request.msgID,
        request.headers,
        0,
      ),
    ];
  }
  if (request.cmd === "setMany") {
    return (
      mesg.data as {
        key?: unknown;
        msgID?: unknown;
        messageData: { raw: Buffer; encoding: any; headers?: unknown };
      }[]
    ).map(({ key, msgID, messageData }, i) =>
      record(
        messageData.encoding,
        messageData.raw,
        key,
        msgID,
        messageData.headers,
        i,
      ),
    );
  }
  return undefined;
}

// A request's records decoded, and their snapshot bodies scanned, by
// position: done before the synchronous step (server.ts), in slices that
// yield to the event loop, so a snapshot's scan never holds it (daybreak2).
// A record that won't decode is left to requestRecords, which refuses it.
export type PreparedRequest = (
  | {
      encoding: any;
      data: Buffer | undefined;
      value: unknown;
      document?: boolean;
    }
  | undefined
)[];

export async function prepareRequest(
  request: { cmd?: unknown },
  mesg: { raw?: Buffer; encoding?: any; data?: any },
): Promise<PreparedRequest | undefined> {
  const messages: { encoding: any; data: Buffer | undefined }[] =
    request.cmd === "set"
      ? [{ encoding: mesg.encoding, data: mesg.raw }]
      : request.cmd === "setMany" && Array.isArray(mesg.data)
        ? mesg.data.map((m: any) => ({
            encoding: m?.messageData?.encoding,
            data: m?.messageData?.raw,
          }))
        : [];
  if (messages.length === 0) return;
  const prepared: PreparedRequest = [];
  for (const { encoding, data } of messages) {
    let value: unknown;
    try {
      value = decode({ encoding, data });
    } catch {
      prepared.push(undefined);
      continue;
    }
    const body = snapshotBody(value);
    prepared.push({
      encoding,
      data,
      value,
      ...(body == null ? {} : { document: await isJsonObjectLinesAsync(body) }),
    });
  }
  return prepared;
}

// The stored graph read, if it must be (the cache is missing or stale),
// with every stored snapshot body scanned in yielding slices first; so the
// synchronous step finds it ready. If the stream moved meanwhile, nothing is
// cached (the synchronous step reads it again, scanning there).
export async function prepareAppend(stream: AppendStream): Promise<void> {
  const seq = newestSeq(stream);
  if (checks.get(stream)?.atSeq === seq) return;
  let list: AppendRecord[];
  try {
    list = [...records(stream)];
  } catch {
    return; // (readGraph refuses it.)
  }
  for (const record of list) {
    const body = snapshotBody(record.value);
    if (body != null) record.document = await isJsonObjectLinesAsync(body);
  }
  if (newestSeq(stream) !== seq || checks.get(stream)?.atSeq === seq) return;
  checks.set(stream, graphOf(list, seq));
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
