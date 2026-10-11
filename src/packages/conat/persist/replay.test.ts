/*
 *  This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A replay must not monopolize the persist server: a stream holding a huge
// message (a 500 MB runaway notebook output) stalled a production host's
// persist daemon for 7-8 s out of every 8 s while one browser kept retrying.

import { initContext } from "./context";
import { replay, type ReplayControl } from "./server";
import type { StoredRow } from "./storage";

const pending: { buf: Buffer; resolve: (b: Buffer) => void }[] = [];
let decompressSyncCalls = 0;

initContext({
  sqlite: { DatabaseSync: class {} as any },
  compress: (b: Buffer) => b,
  decompress: (b: Buffer) => {
    decompressSyncCalls += 1;
    return b;
  },
  // resolves only when a test releases it
  decompressAsync: (buf: Buffer) =>
    new Promise<Buffer>((resolve) => pending.push({ buf, resolve })),
  syncFiles: {} as any,
  ensureContainingDirectoryExists: async () => {},
  statSync: () => ({ mtimeMs: 0 }),
  copyFileSync: () => {},
});

const ZSTD = 1;

function row(seq: number, size: number, compress = ZSTD): StoredRow {
  return {
    seq,
    key: null,
    time: seq,
    compress,
    encoding: 0,
    raw: Buffer.from(`m${seq}`),
    headers: null,
    size,
  };
}

function fakeStream(rows: StoredRow[]) {
  const pageCalls: number[] = [];
  return {
    pageCalls,
    stream: {
      config: () => ({}),
      getMetadata: () => undefined,
      getCheckpoints: () => ({}),
      getCheckpoint: () => undefined,
      seqBounds: () => ({
        oldest_retained_seq: rows[0]?.seq,
        newest_retained_seq: rows.at(-1)?.seq,
      }),
      isClosing: () => false,
      getPage: ({ after_seq, maxRows }) => {
        pageCalls.push(after_seq);
        return rows.filter((r) => r.seq > after_seq).slice(0, maxRows);
      },
    } as any,
  };
}

function fakeMesg() {
  const frames: { data: any; seq: number }[] = [];
  return {
    frames,
    mesg: {
      respondSync: (data, { headers }) => {
        frames.push({ data, seq: headers.seq });
      },
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function releaseAll() {
  while (pending.length > 0) {
    const { buf, resolve } = pending.shift()!;
    resolve(buf);
    await flush();
  }
}

describe("persist replay", () => {
  beforeEach(() => {
    pending.length = 0;
    decompressSyncCalls = 0;
    delete process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES;
  });

  it("decompresses small messages inline and large ones off the event loop", async () => {
    const { stream } = fakeStream([row(1, 100), row(2, 5_000_000)]);
    const { mesg, frames } = fakeMesg();
    const done = replay({ stream, mesg, request: {}, messagesThresh: 1e9 });
    await flush();
    expect(decompressSyncCalls).toBe(1);
    expect(pending).toHaveLength(1);
    await releaseAll();
    await done;
    expect(frames.map((f) => f.data?.map((m) => m.seq) ?? null)).toEqual([
      [1, 2],
      null,
    ]);
  });

  it("sends keepalive frames while a large message is decompressed", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    try {
      const { stream } = fakeStream([row(1, 5_000_000)]);
      const { mesg, frames } = fakeMesg();
      const done = replay({ stream, mesg, request: {}, messagesThresh: 1e9 });
      await flush();
      expect(pending).toHaveLength(1);
      // The requester's idle timeout (2.5 s for recovery) would expire here
      // without keepalives, and its retry would start the replay over.
      jest.advanceTimersByTime(3_000);
      const keepalives = frames.filter((f) => f.data?.length === 0).length;
      expect(keepalives).toBeGreaterThanOrEqual(2);
      await releaseAll();
      await done;
      // frame numbering stays contiguous, so clients accept the reply
      expect(frames.map((f) => f.seq)).toEqual(frames.map((_, i) => i));
      expect(frames.at(-1)?.data).toBeUndefined();
      expect(frames.at(-2)?.data?.map((m) => m.seq)).toEqual([1]);
    } finally {
      jest.useRealTimers();
    }
  });

  it("yields to the event loop between pages", async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => row(i + 1, 10, 0));
    const { stream, pageCalls } = fakeStream(rows);
    const { mesg, frames } = fakeMesg();
    let ticks = 0;
    const ticksAtPage: number[] = [];
    const getPage = stream.getPage;
    stream.getPage = (opts) => {
      ticksAtPage.push(ticks);
      return getPage(opts);
    };
    let running = true;
    const tick = () => {
      ticks += 1;
      if (running) setImmediate(tick);
    };
    setImmediate(tick);
    await replay({ stream, mesg, request: {}, messagesThresh: 1e9 });
    running = false;
    // pages of at most 1000 rows, then an empty page
    expect(pageCalls).toEqual([0, 1000, 2000, 2500]);
    // other work ran between consecutive pages
    for (let i = 1; i < ticksAtPage.length; i++) {
      expect(ticksAtPage[i]).toBeGreaterThan(ticksAtPage[i - 1]);
    }
    expect(frames.at(-2)?.data).toHaveLength(2500);
  });

  it("refuses a stored message over the size limit without decompressing it", async () => {
    process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES = "1000000";
    const { stream } = fakeStream([row(1, 100), row(2, 521_056_235)]);
    const { mesg } = fakeMesg();
    await expect(
      replay({ stream, mesg, request: {}, messagesThresh: 1e9 }),
    ).rejects.toMatchObject({ code: 413 });
    expect(pending).toHaveLength(0);
    expect(decompressSyncCalls).toBe(1);
  });

  it("stops quietly once cancelled", async () => {
    const { stream } = fakeStream([row(1, 5_000_000), row(2, 100)]);
    const { mesg, frames } = fakeMesg();
    const control: ReplayControl = { cancelled: false };
    const done = replay({
      stream,
      mesg,
      request: {},
      messagesThresh: 1e9,
      control,
    });
    await flush();
    control.cancelled = true;
    await releaseAll();
    await done;
    expect(frames).toHaveLength(0);
  });

  it("runs at most two large decompressions at once", async () => {
    const replays = [1, 2, 3].map(() => {
      const { stream } = fakeStream([row(1, 5_000_000)]);
      const { mesg } = fakeMesg();
      return replay({ stream, mesg, request: {}, messagesThresh: 1e9 });
    });
    await flush();
    await flush();
    expect(pending).toHaveLength(2);
    pending.shift()!.resolve(Buffer.from("x"));
    await flush();
    await flush();
    expect(pending).toHaveLength(2);
    await releaseAll();
    await Promise.all(replays);
  });
});
