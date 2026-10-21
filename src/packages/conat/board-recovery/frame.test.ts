jest.mock("@msgpack/msgpack", () => {
  const actual = jest.requireActual("@msgpack/msgpack");
  return { ...actual, decode: jest.fn(actual.decode) };
});

import { decode, encode } from "@msgpack/msgpack";
import { BOARD_HISTORY_LIMITS } from "@cocalc/conat/persist/board-history";
import {
  FRAME_CAPS,
  FrameReader,
  JOB_RECORD_OVERHEAD,
  RECOVERY_VALUE_CAP,
  decodeFrameBody,
  encodeFrame,
  jobFrameChunks,
  type HelloFrame,
  type JobFrame,
  type ResultFrame,
} from "./frame";

const JOB_ID = "0123456789abcdef0123456789abcdef";
const SHA = "a".repeat(64);
const decodeSpy = decode as unknown as jest.Mock;

const body = (frame: Uint8Array) => frame.subarray(4);

const hello = (): HelloFrame => ({
  v: 1,
  type: "hello",
  job_id: JOB_ID,
  uid: 999,
  gid: 999,
  groups: [],
  no_new_privs: 1,
  cap_eff: "0",
  cap_prm: "0",
  fds: [
    { fd: 0, target: "pipe:[1]" },
    { fd: 1, target: "pipe:[2]" },
    { fd: 2, target: "pipe:[3]" },
    { fd: 3, target: "anon_inode:[eventpoll]" },
  ],
  cgroup: `/cocalc-board-recovery/job-${JOB_ID}`,
  limits: { memory_max: "1073741824", swap_max: "0" },
});

const result = (over: Partial<ResultFrame> = {}): ResultFrame => ({
  v: 1,
  type: "result",
  job_id: JOB_ID,
  input_sha256: SHA,
  verdict: "clean",
  value: '{"type":"doc"}',
  identifiers: ["a_1", "b_2"],
  ...over,
});

beforeEach(() => decodeSpy.mockClear());

describe("maximal legitimate frames fit their caps and decode", () => {
  test("a job of 20,000 records holding the whole 64 MiB", () => {
    const L = BOARD_HISTORY_LIMITS;
    // One record as large as a record may be, and the rest sharing what
    // remains of the history's bytes.
    const each = Math.floor((L.totalBytes - L.recordBytes) / (L.records - 1));
    const raw = new Uint8Array(each);
    const records = [
      { encoding: 0, raw: new Uint8Array(L.recordBytes) },
      ...Array.from({ length: L.records - 1 }, () => ({ encoding: 255, raw })),
    ];
    const job: JobFrame = {
      v: 1,
      type: "job",
      job_id: JOB_ID,
      kind: "reconstruct",
      records,
    };
    const frame = encodeFrame(job);
    expect(frame.byteLength - 4).toBeLessThanOrEqual(FRAME_CAPS.job);
    // The overhead per record, measured, is within the constant.
    const one = encode({ encoding: 255, raw: new Uint8Array(2 ** 16) });
    expect(one.byteLength - 2 ** 16).toBeLessThanOrEqual(JOB_RECORD_OVERHEAD);
    expect(decodeFrameBody("job", body(frame)).records).toHaveLength(L.records);
  });

  test("a result with the value cap and 20,000 longest identifiers", () => {
    const id = "x".repeat(BOARD_HISTORY_LIMITS.idChars);
    const frame = encodeFrame(
      result({
        value: "v".repeat(RECOVERY_VALUE_CAP),
        identifiers: Array(BOARD_HISTORY_LIMITS.records).fill(id),
      }),
    );
    expect(frame.byteLength - 4).toBeLessThanOrEqual(FRAME_CAPS.result);
    expect(decodeFrameBody("result", body(frame)).value).toHaveLength(
      RECOVERY_VALUE_CAP,
    );
  });

  test("a hello with Node's runtime fds", () => {
    const h = hello();
    h.fds = Array.from({ length: 64 }, (_, fd) => ({
      fd,
      target: fd < 3 ? `pipe:[${fd}]` : "anon_inode:[eventfd]",
    }));
    const frame = encodeFrame(h);
    expect(frame.byteLength - 4).toBeLessThanOrEqual(FRAME_CAPS.hello);
    expect(decodeFrameBody("hello", body(frame))).toEqual(h);
  });
});

describe("refused before decode", () => {
  const deep = (n: number) => {
    let x: unknown = [];
    for (let i = 0; i < n - 1; i++) x = [x];
    return x;
  };
  test.each(["job", "hello", "result"] as const)(
    "%s: astra's 64-nested probe, depth+1, a wide header, trailing bytes",
    (kind) => {
      const probe = encode(deep(64));
      expect(() => decodeFrameBody(kind as any, probe)).toThrow(/nested over/);
      const maxDepth = kind === "job" ? 6 : 4;
      expect(() =>
        decodeFrameBody(kind as any, encode({ v: 1, x: deep(maxDepth) })),
      ).toThrow(/nested over/);
      expect(() =>
        decodeFrameBody(
          kind as any,
          Uint8Array.from([0xdd, 255, 255, 255, 255]),
        ),
      ).toThrow(/msgpack scan/);
      const ok = encode({ v: 1 });
      const trailing = new Uint8Array(ok.byteLength + 1);
      trailing.set(ok);
      expect(() => decodeFrameBody(kind as any, trailing)).toThrow(/trailing/);
      expect(decodeSpy).not.toHaveBeenCalled();
    },
  );
});

describe("strict schemas", () => {
  test("hello: unknown or missing fields, wrong types", () => {
    const enc = (x: object) => encode(x);
    expect(() =>
      decodeFrameBody("hello", enc({ ...hello(), extra: 1 })),
    ).toThrow(/unknown field extra/);
    const { uid: _uid, ...missing } = hello();
    expect(() => decodeFrameBody("hello", enc(missing))).toThrow(/no uid/);
    expect(() =>
      decodeFrameBody("hello", enc({ ...hello(), uid: "0" })),
    ).toThrow(/uid/);
    expect(() => decodeFrameBody("hello", enc({ ...hello(), v: 2 }))).toThrow(
      /version/,
    );
    expect(() =>
      decodeFrameBody("hello", enc({ ...hello(), type: "result" })),
    ).toThrow(/expected a hello/);
  });

  test("result: a value only for clean and non-linear histories", () => {
    for (const verdict of ["incomplete", "invalid"] as const) {
      expect(() =>
        decodeFrameBody("result", encode(result({ verdict }))),
      ).toThrow(/has no value/);
      expect(
        decodeFrameBody("result", encode(result({ verdict, value: null }))),
      ).toMatchObject({ verdict, value: null });
    }
    expect(() =>
      decodeFrameBody("result", encode(result({ value: null }))),
    ).toThrow(/value/);
    expect(() =>
      decodeFrameBody("result", encode({ ...result(), verdict: "partial" })),
    ).toThrow(/unknown verdict/);
    expect(() =>
      decodeFrameBody("result", encode(result({ identifiers: ["a b"] }))),
    ).toThrow(/identifier/);
  });

  test("job: records are exactly {encoding, raw}", () => {
    const job = (records: unknown[]) =>
      encode({
        v: 1,
        type: "job",
        job_id: JOB_ID,
        kind: "reconstruct",
        records,
      });
    expect(
      decodeFrameBody("job", job([{ encoding: 0, raw: new Uint8Array(1) }])),
    ).toMatchObject({ kind: "reconstruct" });
    expect(() =>
      decodeFrameBody("job", job([{ encoding: 0, raw: "text" }])),
    ).toThrow(/bin/);
    expect(() =>
      decodeFrameBody(
        "job",
        job([{ encoding: 0, raw: new Uint8Array(1), x: 1 }]),
      ),
    ).toThrow(/unknown field/);
  });
});

describe("FrameReader", () => {
  test("frames split anywhere are reassembled, in order", () => {
    const frames: [string, Uint8Array][] = [];
    const reader = new FrameReader(["hello", "result"], (kind, b) =>
      frames.push([kind, b]),
    );
    const bytes = new Uint8Array([
      ...encodeFrame(hello()),
      ...encodeFrame(result()),
    ]);
    for (let i = 0; i < bytes.byteLength; i += 3) {
      reader.push(bytes.subarray(i, i + 3));
    }
    expect(reader.error).toBeUndefined();
    expect(reader.done).toBe(true);
    expect(frames.map(([k]) => k)).toEqual(["hello", "result"]);
    expect(decodeFrameBody("result", frames[1][1])).toEqual(result());
  });

  test("a header over its kind's cap is refused before any body byte", () => {
    const onFrame = jest.fn();
    const reader = new FrameReader(["hello"], onFrame);
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, FRAME_CAPS.hello + 1);
    reader.push(header);
    expect(reader.error?.message).toMatch(/over its cap/);
    reader.push(new Uint8Array(10));
    expect(onFrame).not.toHaveBeenCalled();
  });

  test("bytes after the last frame are an error", () => {
    const reader = new FrameReader(["result"], () => {});
    reader.push(new Uint8Array([...encodeFrame(result()), 0]));
    expect(reader.error?.message).toMatch(/after the last frame/);
  });
});

test("jobFrameChunks: exactly encodeFrame's bytes, without copying records", () => {
  for (const n of [0, 1, 15, 16, 300]) {
    const records = Array.from({ length: n }, (_, i) => ({
      encoding: i % 2 === 0 ? i % 2 : 200,
      raw: new Uint8Array(i % 3 === 0 ? 300 : i % 3 === 1 ? 70_000 : 5).fill(i),
    }));
    const job: JobFrame = {
      v: 1,
      type: "job",
      job_id: JOB_ID,
      kind: "reconstruct",
      records,
    };
    const chunks = [...jobFrameChunks(job)];
    const total = chunks.reduce((a, c) => a + c.byteLength, 0);
    const joined = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      joined.set(c, at);
      at += c.byteLength;
    }
    expect(Buffer.from(joined).equals(Buffer.from(encodeFrame(job)))).toBe(
      true,
    );
    // The records' own bytes are passed through, not copied.
    for (const r of records) expect(chunks).toContain(r.raw);
  }
});
