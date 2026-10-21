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
  parseBoardRecord,
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
  // Grows with every row the stream's database changes (storage.ts).
  mutationCount?(): number;
}

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
    return brokenGraph(seq, err);
  }
}

// E.g. a stored record over the record cap: nothing may be appended.
function brokenGraph(seq: number, err: unknown): BoardAppendCheck {
  return new BoardAppendCheck({
    seq,
    broken: `its stored history can't be read: ${err}`.slice(0, 300),
  });
}

function checkFor(stream: AppendStream): BoardAppendCheck {
  let check = checks.get(stream);
  if (check == null || !cacheFresh(stream)) {
    const revision = revisionOf(stream);
    check = readGraph(stream);
    checks.set(stream, check);
    revisions.set(stream, revision);
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
// with every stored record read and every snapshot body scanned in slices
// that yield to the event loop; so the synchronous step finds it ready and
// never reads or scans (daybreak2). If the stream moves meanwhile (its
// newest seq, or a delete or reset: epochs), it is read again, at most
// attempts times. Resolves with whether the graph is ready; if not, the
// synchronous step refuses the request as "board-retry" (appendCheckPrepared).
export async function prepareAppend(
  stream: AppendStream,
  attempts: number = PREPARE_ATTEMPTS,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const seq = newestSeq(stream);
    const revision = revisionOf(stream);
    if (cacheFresh(stream)) return true;
    const list: AppendRecord[] = [];
    let error: unknown;
    try {
      // Streamed, as readGraph is: read up to the first record the open
      // check refuses (one that isn't a board record or has a key, or the
      // one past the history's total bytes or record count), and no
      // further; so at most the history's bounds, plus that one record,
      // are ever held (astra LIMIT-7B0-1).
      let sinceYield = 0;
      let bytes = 0;
      for (const record of records(stream)) {
        list.push(record);
        bytes += record.bytes;
        const body = snapshotBody(record.value);
        if (body != null) record.document = await isJsonObjectLinesAsync(body);
        if (
          record.key != null ||
          bytes > BOARD_HISTORY_LIMITS.totalBytes ||
          "invalid" in
            parseBoardRecord(record.value, undefined, record.document)
        ) {
          break;
        }
        sinceYield += record.bytes;
        if (sinceYield >= PREPARE_READ_SLICE_BYTES) {
          sinceYield = 0;
          await yieldToEventLoop();
        }
      }
    } catch (err) {
      error = err; // E.g. a record over the cap: nothing may be appended.
    }
    // Meanwhile another append may have committed the graph forward.
    if (cacheFresh(stream)) return true;
    // Anything else written meanwhile: read again.
    if (revisionOf(stream) !== revision) continue;
    checks.set(
      stream,
      error == null ? graphOf(list, seq) : brokenGraph(seq, error),
    );
    revisions.set(stream, revision);
    return true;
  }
  return false;
}

const PREPARE_ATTEMPTS = 4;
const PREPARE_READ_SLICE_BYTES = 1024 * 1024;
const yieldToEventLoop = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

// Each forgetAppendHead (a delete, a reset, a config change, a store that
// wasn't as projected) starts a new epoch: a graph read across one is
// read again.
const epochs = new WeakMap<object, number>();

// The stream's revision: its mutation count (every write, delete or reset,
// by any path) and its epoch. The cached graph is valid only at the
// revision it was read or committed at (astra CORR-7B0-1: a delete can
// leave the newest seq as it was).
const revisions = new WeakMap<object, string>();
const revisionOf = (stream: AppendStream) =>
  `${stream.mutationCount?.() ?? "-"}:${epochs.get(stream) ?? 0}`;
const cacheFresh = (stream: AppendStream) =>
  checks.get(stream)?.atSeq === newestSeq(stream) &&
  revisions.get(stream) === revisionOf(stream);

/*
The server's synchronous step (server.ts): after prepareRequest and
prepareAppend, it reads nothing and scans nothing. A graph that isn't
ready, or a snapshot record without its scanned verdict, is refused as
"board-retry" before anything is stored: not a fence refusal, so the
writer keeps its edits and its save retries (dstream.save, with backoff).
*/
export function appendCheckPrepared(
  stream: AppendStream,
  records: AppendRecord[],
): ReturnType<typeof appendCheck> {
  const check = checks.get(stream);
  if (check == null || !cacheFresh(stream)) {
    throw retry("the board's stored history changed while it was read");
  }
  for (const record of records) {
    if (record.document == null && snapshotBody(record.value) != null) {
      throw retry("a snapshot record that wasn't scanned before the store");
    }
  }
  return { check, next: check.check(records) };
}

const retry = (message: string) =>
  new ConatError(`${message}; retry`, { code: "board-retry" });

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
    // Exactly the store just projected: the graph is that revision's.
    revisions.set(stream, revisionOf(stream));
  } else {
    forgetAppendHead(stream);
  }
}

// After anything else that changes the stream (a delete, a reset): the head
// is read again before the next append.
export function forgetAppendHead(stream: AppendStream): void {
  checks.delete(stream);
  epochs.set(stream, (epochs.get(stream) ?? 0) + 1);
}
