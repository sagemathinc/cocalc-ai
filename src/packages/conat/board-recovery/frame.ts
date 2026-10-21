/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The board recovery protocol between the host's runner and the isolated
child (project-host/board/recovery.ts and recovery-child.ts; design: the
isolation plan, r7).

Each direction carries length-prefixed frames, `[u32 big-endian length]
[msgpack body]`, versioned (v: 1):

  child -> parent: hello (who and where it is), then one result, then EOF;
  parent -> child: one job, then EOF.

A body is read only up to its kind's cap (checked from the 4-byte header,
before any body byte is kept), scanned structurally (msgpack-scan.ts: depth,
item count, lengths, exact end) before it is decoded, decoded with
@msgpack/msgpack's own length options as a second bound, and validated
against its schema, strictly: an unknown or missing field, a wrong type, a
second frame or trailing bytes are a protocol error.

Nothing here imports Node modules.
*/

import { decode, encode } from "@msgpack/msgpack";
import { BOARD_HISTORY_LIMITS } from "@cocalc/conat/persist/board-history";
import { BOARD_EDITABLE_LIMIT } from "@cocalc/util/board/names";
import { scanMsgpack, type MsgpackLimits } from "./msgpack-scan";

export const RECOVERY_PROTOCOL_VERSION = 1;

export class ProtocolError extends Error {
  constructor(message: string) {
    super(`board recovery protocol: ${message}`);
  }
}

export type Verdict = "clean" | "non-linear" | "incomplete" | "invalid";
export const VERDICTS: readonly Verdict[] = [
  "clean",
  "non-linear",
  "incomplete",
  "invalid",
];

// A stored record as the persist server keeps it.
export interface JobRecord {
  encoding: number;
  raw: Uint8Array;
}

export interface JobFrame {
  v: 1;
  type: "job";
  job_id: string;
  kind: "reconstruct";
  records: JobRecord[];
}

export interface HelloFrame {
  v: 1;
  type: "hello";
  job_id: string;
  uid: number;
  gid: number;
  groups: number[];
  no_new_privs: number;
  cap_eff: string;
  cap_prm: string;
  // Each open fd and what it is (its /proc/self/fd link).
  fds: { fd: number; target: string }[];
  cgroup: string;
  limits: { memory_max: string; swap_max: string };
}

export interface ResultFrame {
  v: 1;
  type: "result";
  job_id: string;
  // SHA-256 (hex) of the exact job body the child decoded.
  input_sha256: string;
  verdict: Verdict;
  // The board's syncdb value (its string form): only for "clean" and
  // "non-linear"; null otherwise, so a partial graph's value is never
  // produced as a recovered board.
  value: string | null;
  // The patch ids reconstructed, sorted.
  identifiers: string[];
}

export type FrameKind = "job" | "hello" | "result";

const JOB_ID = /^[0-9a-f]{32}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CAP_HEX = /^[0-9a-f]{1,16}$/;
const PATCH_ID = /^[0-9A-Za-z_-]+$/;

export const RECOVERY_VALUE_CAP = BOARD_EDITABLE_LIMIT;
const MAX_RECORDS = BOARD_HISTORY_LIMITS.records;
// Bytes a job record adds to its raw bytes in the job frame: a 2-entry map
// header (1), "encoding" (9) and its integer (at most 9), "raw" (4), and a
// bin 32 header (5). frame.test.ts checks the maximal job fits.
export const JOB_RECORD_OVERHEAD = 32;
const ENVELOPE = 64 * 1024;

export const FRAME_CAPS: Record<FrameKind, number> = {
  job:
    BOARD_HISTORY_LIMITS.totalBytes +
    MAX_RECORDS * JOB_RECORD_OVERHEAD +
    ENVELOPE,
  hello: ENVELOPE,
  // The value, its str header, and the identifiers (each a str of at most
  // idChars, with its header).
  result:
    RECOVERY_VALUE_CAP +
    MAX_RECORDS * (BOARD_HISTORY_LIMITS.idChars + 3) +
    ENVELOPE,
};

export const SCAN_LIMITS: Record<FrameKind, MsgpackLimits> = {
  // {records: [{encoding, raw}]}: depth 3 (the plan allows 6).
  job: {
    maxDepth: 6,
    // The envelope's 5 entries (10 items), each record (1) and its 2
    // entries (4).
    maxElements: 32 + MAX_RECORDS * 5,
    maxStrLength: 4096,
    maxBinLength: BOARD_HISTORY_LIMITS.recordBytes,
    maxArrayLength: MAX_RECORDS,
    maxMapLength: 16,
  },
  // {groups: [], fds: [{fd, target}], limits: {}}: depth 3.
  hello: {
    maxDepth: 4,
    maxElements: 4096,
    maxStrLength: 4096,
    maxBinLength: 0,
    maxArrayLength: 1024,
    maxMapLength: 16,
  },
  // {identifiers: []}: depth 2.
  result: {
    maxDepth: 4,
    maxElements: 32 + MAX_RECORDS,
    maxStrLength: RECOVERY_VALUE_CAP,
    maxBinLength: 0,
    maxArrayLength: MAX_RECORDS,
    maxMapLength: 16,
  },
};

export function encodeFrame(
  body: JobFrame | HelloFrame | ResultFrame,
): Uint8Array {
  const payload = encode(body);
  const frame = new Uint8Array(4 + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength);
  frame.set(payload, 4);
  return frame;
}

/*
A job frame as a sequence of chunks, without copying or re-encoding the
records' bytes: the envelope and each record's small header are encoded
here, and each record's raw bytes are passed through as they are. The bytes
are exactly encodeFrame's (frame.test.ts checks). The chunks are made
lazily, one record at a time, so the host can write a 64 MiB job without one
long synchronous step (recovery.ts yields between chunks). The first chunk
is the 4-byte length header.
*/
const ENCODING_KEY = encode("encoding");
const RAW_KEY = encode("raw");

function recordHeader(encoding: number, rawLength: number): Uint8Array {
  // (A board record's encoding is 0 or 1; anything up to 255 is encoded as
  // msgpack would: a positive fixint, or uint 8.)
  const enc =
    encoding <= 0x7f ? Uint8Array.of(encoding) : Uint8Array.of(0xcc, encoding);
  const bin = binHeader(rawLength);
  const out = new Uint8Array(
    1 +
      ENCODING_KEY.byteLength +
      enc.byteLength +
      RAW_KEY.byteLength +
      bin.byteLength,
  );
  let at = 0;
  for (const part of [Uint8Array.of(0x82), ENCODING_KEY, enc, RAW_KEY, bin]) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

function recordHeaderLength(encoding: number, rawLength: number): number {
  return (
    1 +
    ENCODING_KEY.byteLength +
    (encoding <= 0x7f ? 1 : 2) +
    RAW_KEY.byteLength +
    (rawLength <= 0xff ? 2 : rawLength <= 0xffff ? 3 : 5)
  );
}

export function* jobFrameChunks(job: JobFrame): Generator<Uint8Array> {
  const prefix = concat(
    [
      Uint8Array.of(0x85),
      encode("v"),
      encode(job.v),
      encode("type"),
      encode(job.type),
      encode("job_id"),
      encode(job.job_id),
      encode("kind"),
      encode(job.kind),
      encode("records"),
      arrayHeader(job.records.length),
    ],
    -1,
  );
  let length = prefix.byteLength;
  for (const { encoding, raw } of job.records) {
    length += recordHeaderLength(encoding, raw.byteLength) + raw.byteLength;
  }
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, length);
  yield header;
  yield prefix;
  for (const { encoding, raw } of job.records) {
    yield recordHeader(encoding, raw.byteLength);
    yield raw;
  }
}

function arrayHeader(n: number): Uint8Array {
  if (n <= 15) return Uint8Array.of(0x90 | n);
  if (n <= 0xffff) return Uint8Array.of(0xdc, n >> 8, n & 0xff);
  const h = new Uint8Array(5);
  h[0] = 0xdd;
  new DataView(h.buffer).setUint32(1, n);
  return h;
}

function binHeader(n: number): Uint8Array {
  if (n <= 0xff) return Uint8Array.of(0xc4, n);
  if (n <= 0xffff) return Uint8Array.of(0xc5, n >> 8, n & 0xff);
  const h = new Uint8Array(5);
  h[0] = 0xc6;
  new DataView(h.buffer).setUint32(1, n);
  return h;
}

// Decode and validate one frame body of this kind (its header already read
// and its length checked against FRAME_CAPS).
export function decodeFrameBody(kind: "job", body: Uint8Array): JobFrame;
export function decodeFrameBody(kind: "hello", body: Uint8Array): HelloFrame;
export function decodeFrameBody(kind: "result", body: Uint8Array): ResultFrame;
export function decodeFrameBody(
  kind: FrameKind,
  body: Uint8Array,
): JobFrame | HelloFrame | ResultFrame {
  const limits = SCAN_LIMITS[kind];
  try {
    scanMsgpack(body, limits);
  } catch (err) {
    throw new ProtocolError(`${kind}: ${(err as Error).message}`);
  }
  let value: unknown;
  try {
    value = decode(body, {
      maxStrLength: limits.maxStrLength,
      maxBinLength: limits.maxBinLength,
      maxArrayLength: limits.maxArrayLength,
      maxMapLength: limits.maxMapLength,
      maxExtLength: 0,
    });
  } catch (err) {
    throw new ProtocolError(`${kind}: ${(err as Error).message}`);
  }
  switch (kind) {
    case "job":
      return validateJob(value);
    case "hello":
      return validateHello(value);
    case "result":
      return validateResult(value);
  }
}

function fail(message: string): never {
  throw new ProtocolError(message);
}

function plain(x: unknown, what: string): { [key: string]: unknown } {
  if (x == null || typeof x !== "object" || Array.isArray(x)) {
    fail(`${what} is not a map`);
  }
  if (x instanceof Uint8Array) fail(`${what} is not a map`);
  return x as { [key: string]: unknown };
}

function exactKeys(
  x: { [key: string]: unknown },
  keys: string[],
  what: string,
) {
  const have = Object.keys(x);
  for (const k of have) {
    if (!keys.includes(k))
      fail(`${what} has an unknown field ${k.slice(0, 64)}`);
  }
  for (const k of keys) {
    if (!(k in x)) fail(`${what} has no ${k}`);
  }
}

function int(x: unknown, what: string, min = 0, max = 2 ** 32 - 1): number {
  if (typeof x !== "number" || !Number.isInteger(x) || x < min || x > max) {
    fail(`${what} is not an integer in [${min}, ${max}]`);
  }
  return x;
}

function str(x: unknown, what: string, pattern?: RegExp, max = 4096): string {
  if (
    typeof x !== "string" ||
    x.length > max ||
    (pattern && !pattern.test(x))
  ) {
    fail(`${what} is not a valid string`);
  }
  return x;
}

function header(x: { [key: string]: unknown }, type: FrameKind) {
  if (x.v !== RECOVERY_PROTOCOL_VERSION) fail(`${type}: not version 1`);
  if (x.type !== type) fail(`expected a ${type} frame`);
}

function validateJob(value: unknown): JobFrame {
  const x = plain(value, "job");
  exactKeys(x, ["v", "type", "job_id", "kind", "records"], "job");
  header(x, "job");
  str(x.job_id, "job_id", JOB_ID);
  if (x.kind !== "reconstruct") fail("job: unknown kind");
  if (!Array.isArray(x.records) || x.records.length > MAX_RECORDS) {
    fail("job: records is not a list of at most the record limit");
  }
  let total = 0;
  for (const r of x.records) {
    const rec = plain(r, "job record");
    exactKeys(rec, ["encoding", "raw"], "job record");
    int(rec.encoding, "record encoding", 0, 255);
    if (!(rec.raw instanceof Uint8Array)) fail("record raw is not bin");
    total += rec.raw.byteLength;
  }
  if (total > BOARD_HISTORY_LIMITS.totalBytes) {
    fail("job: records over the history's byte limit");
  }
  return x as unknown as JobFrame;
}

function validateHello(value: unknown): HelloFrame {
  const x = plain(value, "hello");
  exactKeys(
    x,
    [
      "v",
      "type",
      "job_id",
      "uid",
      "gid",
      "groups",
      "no_new_privs",
      "cap_eff",
      "cap_prm",
      "fds",
      "cgroup",
      "limits",
    ],
    "hello",
  );
  header(x, "hello");
  str(x.job_id, "job_id", JOB_ID);
  int(x.uid, "uid");
  int(x.gid, "gid");
  if (!Array.isArray(x.groups) || x.groups.length > 64) fail("hello: groups");
  x.groups.forEach((g) => int(g, "group"));
  int(x.no_new_privs, "no_new_privs", 0, 1);
  str(x.cap_eff, "cap_eff", CAP_HEX);
  str(x.cap_prm, "cap_prm", CAP_HEX);
  if (!Array.isArray(x.fds) || x.fds.length > 1024) fail("hello: fds");
  for (const f of x.fds) {
    const fd = plain(f, "hello fd");
    exactKeys(fd, ["fd", "target"], "hello fd");
    int(fd.fd, "fd", 0, 1 << 20);
    str(fd.target, "fd target", undefined, 4096);
  }
  str(x.cgroup, "cgroup", undefined, 4096);
  const limits = plain(x.limits, "hello limits");
  exactKeys(limits, ["memory_max", "swap_max"], "hello limits");
  str(limits.memory_max, "memory_max", /^(max|[0-9]{1,20})$/);
  str(limits.swap_max, "swap_max", /^(max|[0-9]{1,20})$/);
  return x as unknown as HelloFrame;
}

function validateResult(value: unknown): ResultFrame {
  const x = plain(value, "result");
  exactKeys(
    x,
    ["v", "type", "job_id", "input_sha256", "verdict", "value", "identifiers"],
    "result",
  );
  header(x, "result");
  str(x.job_id, "job_id", JOB_ID);
  str(x.input_sha256, "input_sha256", SHA256);
  if (!VERDICTS.includes(x.verdict as Verdict)) fail("result: unknown verdict");
  const withValue = x.verdict === "clean" || x.verdict === "non-linear";
  if (withValue) {
    str(x.value, "value", undefined, RECOVERY_VALUE_CAP);
  } else if (x.value !== null) {
    fail(`result: a ${x.verdict} history has no value`);
  }
  if (!Array.isArray(x.identifiers) || x.identifiers.length > MAX_RECORDS) {
    fail("result: identifiers");
  }
  for (const id of x.identifiers) {
    str(id, "identifier", PATCH_ID, BOARD_HISTORY_LIMITS.idChars);
  }
  return x as unknown as ResultFrame;
}

/*
Reads frames from a byte stream, in order: give it each chunk, and it calls
onFrame with each complete body. The header goes into a fixed 4-byte buffer;
a length over the current kind's cap is a protocol error before any body
byte is kept. After the last expected frame, any further byte is a protocol
error (trailing bytes).
*/
export class FrameReader {
  private headerBytes = new Uint8Array(4);
  private headerFill = 0;
  private bodyLength = -1;
  private chunks: Uint8Array[] = [];
  private bodyFill = 0;
  private failed?: ProtocolError;
  private index = 0;

  constructor(
    // The kind of each expected frame, in order; nothing after the last.
    private readonly kinds: FrameKind[],
    private readonly onFrame: (kind: FrameKind, body: Uint8Array) => void,
  ) {}

  get error(): ProtocolError | undefined {
    return this.failed;
  }

  // All expected frames were read.
  get done(): boolean {
    return this.index >= this.kinds.length;
  }

  // At a frame boundary (no partial frame read).
  get atBoundary(): boolean {
    return this.headerFill === 0 && this.bodyLength < 0;
  }

  push(chunk: Uint8Array): void {
    let pos = 0;
    while (pos < chunk.byteLength && this.failed == null) {
      if (this.done) {
        this.failed = new ProtocolError("bytes after the last frame");
        return;
      }
      const kind = this.kinds[this.index];
      if (this.bodyLength < 0) {
        const n = Math.min(4 - this.headerFill, chunk.byteLength - pos);
        this.headerBytes.set(chunk.subarray(pos, pos + n), this.headerFill);
        this.headerFill += n;
        pos += n;
        if (this.headerFill < 4) continue;
        const length = new DataView(this.headerBytes.buffer).getUint32(0);
        if (length > FRAME_CAPS[kind]) {
          this.failed = new ProtocolError(
            `a ${kind} frame of ${length} bytes, over its cap of ${FRAME_CAPS[kind]}`,
          );
          return;
        }
        this.bodyLength = length;
        this.bodyFill = 0;
        this.chunks = [];
      }
      const n = Math.min(
        this.bodyLength - this.bodyFill,
        chunk.byteLength - pos,
      );
      if (n > 0) {
        this.chunks.push(chunk.slice(pos, pos + n));
        this.bodyFill += n;
        pos += n;
      }
      if (this.bodyFill === this.bodyLength) {
        const body = concat(this.chunks, this.bodyLength);
        this.chunks = [];
        this.bodyLength = -1;
        this.headerFill = 0;
        this.index += 1;
        try {
          this.onFrame(kind, body);
        } catch (err) {
          this.failed =
            err instanceof ProtocolError
              ? err
              : new ProtocolError(`${(err as Error).message}`);
          return;
        }
      }
    }
  }
}

// (length -1: the chunks' total.)
function concat(chunks: Uint8Array[], length: number): Uint8Array {
  if (length < 0) length = chunks.reduce((n, c) => n + c.byteLength, 0);
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
