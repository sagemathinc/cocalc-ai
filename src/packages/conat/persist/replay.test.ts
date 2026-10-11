/*
 *  This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A replay must not monopolize the persist server: a stream holding a huge
// message (a 500 MB runaway notebook output) stalled a production host's
// persist daemon for 7-8 s out of every 8 s while one browser kept retrying.

import { initContext } from "./context";
import { replay, ReplayAdmission, resetReplayAdmission } from "./server";
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
const BIG = 5_000_000;

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

// A fake PersistentStream over an array of rows; onPlan runs before each page
// is planned (e.g., to append rows like a concurrent writer).
function fakeStream(rows: StoredRow[], onPlan?: (n: number) => void) {
  const planCalls: number[] = [];
  const readCalls: [number, number][] = [];
  return {
    rows,
    planCalls,
    readCalls,
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
      planPage: ({ after_seq, end_seq, maxRows, maxBytes }) => {
        onPlan?.(planCalls.length);
        planCalls.push(after_seq);
        const page: { seq: number; size: number }[] = [];
        let bytes = 0;
        for (const r of rows) {
          if (r.seq <= after_seq || (end_seq != null && r.seq > end_seq)) {
            continue;
          }
          bytes += r.size;
          if (page.length >= maxRows || (bytes > maxBytes && page.length > 0))
            break;
          page.push({ seq: r.seq, size: r.size });
        }
        return page;
      },
      readPage: (after_seq: number, last_seq: number) => {
        readCalls.push([after_seq, last_seq]);
        return rows.filter((r) => r.seq > after_seq && r.seq <= last_seq);
      },
    } as any,
  };
}

function fakeMesg() {
  const frames: { data: any; seq: number; at: number }[] = [];
  return {
    frames,
    mesg: {
      // like the real respondSync, which encodes synchronously, keep a copy
      respondSync: (data, { headers }) => {
        frames.push({ data: data?.slice(), seq: headers.seq, at: Date.now() });
      },
    },
  };
}

function replayedSeqs(frames: { data: any }[]): number[] {
  return frames.flatMap((f) => (f.data ?? []).map((m) => m.seq));
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
    resetReplayAdmission();
  });

  it("decompresses small messages inline and large ones off the event loop", async () => {
    const { stream } = fakeStream([row(1, 100), row(2, BIG)]);
    const { mesg, frames } = fakeMesg();
    const done = replay({ stream, mesg, request: {}, messagesThresh: 1e9 });
    await flush();
    await flush();
    expect(pending).toHaveLength(1);
    await releaseAll();
    await done;
    expect(decompressSyncCalls).toBe(1);
    expect(replayedSeqs(frames)).toEqual([1, 2]);
    expect(frames.at(-1)?.data).toBeUndefined();
  });

  it("sends keepalive frames while a large message is decompressed", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    try {
      const { stream } = fakeStream([row(1, BIG)]);
      const { mesg, frames } = fakeMesg();
      const done = replay({
        stream,
        mesg,
        request: { timeout: 2500 },
        messagesThresh: 1e9,
      });
      await flush();
      await flush();
      expect(pending).toHaveLength(1);
      // The requester's idle timeout (2.5 s for recovery) would expire here
      // without keepalives, and its retry would start the replay over.
      const started = Date.now();
      for (let i = 0; i < 30; i++) jest.advanceTimersByTime(100);
      const keepalives = frames.filter((f) => f.data?.length === 0);
      expect(keepalives.length).toBeGreaterThanOrEqual(2);
      // no gap between frames reaches the requester's timeout
      const times = [started, ...keepalives.map((f) => f.at), Date.now()];
      for (let i = 1; i < times.length; i++) {
        expect(times[i] - times[i - 1]).toBeLessThan(2500);
      }
      await releaseAll();
      await done;
      // frame numbering stays contiguous, so clients accept the reply
      expect(frames.map((f) => f.seq)).toEqual(frames.map((_, i) => i));
      expect(replayedSeqs(frames)).toEqual([1]);
    } finally {
      jest.useRealTimers();
    }
  });

  it("yields to the event loop between pages", async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => row(i + 1, 10, 0));
    const { stream, planCalls } = fakeStream(rows);
    const { mesg, frames } = fakeMesg();
    let ticks = 0;
    const ticksAtPage: number[] = [];
    const planPage = stream.planPage;
    stream.planPage = (opts) => {
      ticksAtPage.push(ticks);
      return planPage(opts);
    };
    let running = true;
    const tick = () => {
      ticks += 1;
      if (running) setImmediate(tick);
    };
    setImmediate(tick);
    await replay({
      stream,
      mesg,
      request: {},
      messagesThresh: 1e9,
      changefeedActive: true,
    });
    running = false;
    // pages of at most 1000 rows, then an empty page
    expect(planCalls).toEqual([0, 1000, 2000, 2500]);
    for (let i = 1; i < ticksAtPage.length; i++) {
      expect(ticksAtPage[i]).toBeGreaterThan(ticksAtPage[i - 1]);
    }
    expect(replayedSeqs(frames)).toHaveLength(2500);
  });

  it("refuses a stored message over the size limit without reading it", async () => {
    process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES = "1000000";
    const { stream, readCalls } = fakeStream([
      row(1, 100),
      row(2, 521_056_235),
    ]);
    const { mesg } = fakeMesg();
    await expect(
      replay({ stream, mesg, request: {}, messagesThresh: 1e9 }),
    ).rejects.toMatchObject({ code: 413 });
    expect(pending).toHaveLength(0);
    // only the page before the oversized message was read
    expect(readCalls).toEqual([[0, 1]]);
  });

  it("stops quietly once aborted", async () => {
    const { stream } = fakeStream([row(1, BIG), row(2, 100)]);
    const { mesg, frames } = fakeMesg();
    const abort = new AbortController();
    const done = replay({
      stream,
      mesg,
      request: {},
      messagesThresh: 1e9,
      signal: abort.signal,
    });
    await flush();
    await flush();
    abort.abort();
    await releaseAll();
    await done;
    expect(frames).toHaveLength(0);
  });
});

describe("where a replay ends", () => {
  beforeEach(() => {
    pending.length = 0;
    resetReplayAdmission();
  });

  it("with a changefeed, stops at the newest message when it started", async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => row(i + 1, 10, 0));
    // a message appended after the first page is planned
    const { stream } = fakeStream(rows, (n) => {
      if (n == 1) rows.push(row(1501, 10, 0));
    });
    const { mesg, frames } = fakeMesg();
    await replay({
      stream,
      mesg,
      request: {},
      messagesThresh: 1e9,
      changefeedActive: true,
    });
    // the changefeed delivers 1501; the replay must not deliver it too
    const seqs = replayedSeqs(frames);
    expect(seqs).toHaveLength(1500);
    expect(seqs.at(-1)).toBe(1500);
  });

  it("with a changefeed, completes under a constant writer", async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => row(i + 1, 10, 0));
    const { stream } = fakeStream(rows, () => {
      rows.push(row(rows.length + 1, 10, 0));
    });
    const { mesg, frames } = fakeMesg();
    await replay({
      stream,
      mesg,
      request: {},
      messagesThresh: 1e9,
      changefeedActive: true,
    });
    expect(replayedSeqs(frames)).toHaveLength(1500);
  });

  it("without a changefeed, includes messages written during the first pass and then stops", async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => row(i + 1, 10, 0));
    // a constant writer: one new message before every page
    const { stream } = fakeStream(rows, () => {
      rows.push(row(rows.length + 1, 10, 0));
    });
    const { mesg, frames } = fakeMesg();
    await replay({ stream, mesg, request: {}, messagesThresh: 1e9 });
    const seqs = replayedSeqs(frames);
    expect(seqs.length).toBeGreaterThan(1500);
    expect(seqs.length).toBeLessThan(rows.length);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });

  it("honors an explicit end_seq", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i + 1, 10, 0));
    const { stream } = fakeStream(rows);
    const { mesg, frames } = fakeMesg();
    await replay({
      stream,
      mesg,
      request: { start_seq: 3, end_seq: 6 },
      messagesThresh: 1e9,
    });
    expect(replayedSeqs(frames)).toEqual([3, 4, 5, 6]);
  });
});

describe("process-wide admission of replay pages", () => {
  beforeEach(() => {
    pending.length = 0;
  });

  it("reads and decompresses at most two pages with large messages at once", async () => {
    resetReplayAdmission();
    const streams = [1, 2, 3].map(() => fakeStream([row(1, BIG)]));
    const replays = streams.map(({ stream }) =>
      replay({
        stream,
        mesg: fakeMesg().mesg,
        request: {},
        messagesThresh: 1e9,
      }),
    );
    await flush();
    await flush();
    // the third replay waits without reading any message data
    expect(pending).toHaveLength(2);
    expect(streams.map((s) => s.readCalls.length)).toEqual([1, 1, 0]);
    pending.shift()!.resolve(Buffer.from("x"));
    await flush();
    await flush();
    expect(streams[2].readCalls).toHaveLength(1);
    await releaseAll();
    await Promise.all(replays);
  });

  it("counts pages of messages just under 1 MB by their total size", async () => {
    // A page of eight 900 KB messages is "light" message by message, but
    // still 7.2 MB that must fit the budget before it is read.
    resetReplayAdmission(10_000_000, 32);
    const a = fakeStream([row(1, 2_000_000)]); // weighs half the budget
    const b = fakeStream(
      Array.from({ length: 8 }, (_, i) => row(i + 1, 900_000, 0)),
    );
    const ra = replay({
      stream: a.stream,
      mesg: fakeMesg().mesg,
      request: {},
      messagesThresh: 1e9,
    });
    await flush();
    const { mesg, frames } = fakeMesg();
    const rb = replay({
      stream: b.stream,
      mesg,
      request: {},
      messagesThresh: 1e9,
    });
    await flush();
    await flush();
    expect(b.readCalls).toHaveLength(0);
    await releaseAll();
    await Promise.all([ra, rb]);
    expect(replayedSeqs(frames)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("charges every message, so pages of empty messages still wait for budget", async () => {
    // 1000 empty messages are 1000 objects to read and send, not 0 bytes:
    // each page is charged about 1 MB.
    const admission = resetReplayAdmission(1_500_000, 32);
    const streams = [1, 2].map(() =>
      fakeStream(Array.from({ length: 1000 }, (_, i) => row(i + 1, 0, 0))),
    );
    const hold = await admission.acquire(
      1_000_000,
      new AbortController().signal,
    );
    const replays = streams.map(({ stream }) =>
      replay({
        stream,
        mesg: fakeMesg().mesg,
        request: {},
        messagesThresh: 1e9,
      }),
    );
    await flush();
    await flush();
    // neither page fits beside the hold, so neither reads anything yet
    expect(streams.map((s) => s.readCalls.length)).toEqual([0, 0]);
    expect(admission.stats()).toEqual({ used: 1_000_000, waiting: 2 });
    hold();
    await Promise.all(replays);
    expect(streams.map((s) => s.readCalls.length)).toEqual([1, 1]);
    expect(admission.stats()).toEqual({ used: 0, waiting: 0 });
  });

  it("sends each page before releasing its admission", async () => {
    resetReplayAdmission();
    const rows = Array.from({ length: 2500 }, (_, i) => row(i + 1, 10, 0));
    const { stream } = fakeStream(rows);
    const { mesg, frames } = fakeMesg();
    await replay({ stream, mesg, request: {}, messagesThresh: 1e9 });
    expect(frames.map((f) => f.data?.length ?? null)).toEqual([
      1000,
      1000,
      500,
      null,
    ]);
  });

  it("refuses with a retryable error when too many are waiting", async () => {
    resetReplayAdmission(8_000_000, 1);
    const [a, b, c] = [1, 2, 3].map(() => fakeStream([row(1, BIG)]));
    const ra = replay({
      stream: a.stream,
      mesg: fakeMesg().mesg,
      request: {},
      messagesThresh: 1e9,
    });
    await flush();
    const rb = replay({
      stream: b.stream,
      mesg: fakeMesg().mesg,
      request: {},
      messagesThresh: 1e9,
    });
    await flush();
    await expect(
      replay({
        stream: c.stream,
        mesg: fakeMesg().mesg,
        request: {},
        messagesThresh: 1e9,
      }),
    ).rejects.toMatchObject({ code: 503 });
    await releaseAll();
    await Promise.all([ra, rb]);
  });

  it("drops a waiting replay whose socket closed, without reading its data", async () => {
    const admission = resetReplayAdmission(8_000_000, 32);
    const a = fakeStream([row(1, BIG)]);
    const b = fakeStream([row(1, BIG)]);
    const ra = replay({
      stream: a.stream,
      mesg: fakeMesg().mesg,
      request: {},
      messagesThresh: 1e9,
    });
    await flush();
    const abort = new AbortController();
    const { mesg, frames } = fakeMesg();
    const rb = replay({
      stream: b.stream,
      mesg,
      request: {},
      messagesThresh: 1e9,
      signal: abort.signal,
    });
    await flush();
    expect(admission.stats()).toEqual({ used: BIG, waiting: 1 });
    abort.abort();
    await rb;
    expect(admission.stats()).toEqual({ used: BIG, waiting: 0 });
    await releaseAll();
    await ra;
    expect(b.readCalls).toHaveLength(0);
    expect(frames).toHaveLength(0);
    expect(admission.stats()).toEqual({ used: 0, waiting: 0 });
  });
});

describe("ReplayAdmission", () => {
  const never = new AbortController().signal;

  it("admits first come, first served, so small requests cannot starve a large one", async () => {
    const admission = new ReplayAdmission(10, 10);
    const order: string[] = [];
    const r1 = await admission.acquire(6, never);
    const big = admission.acquire(10, never).then((r) => {
      order.push("big");
      return r;
    });
    // fits the remaining budget, but must wait behind the large request
    const small = admission.acquire(1, never).then((r) => {
      order.push("small");
      return r;
    });
    await flush();
    expect(order).toEqual([]);
    r1();
    const rBig = await big;
    await flush();
    expect(order).toEqual(["big"]);
    rBig();
    (await small)();
    expect(order).toEqual(["big", "small"]);
    expect(admission.stats()).toEqual({ used: 0, waiting: 0 });
  });

  it("lets the next waiter in when an aborted request leaves the head of the queue", async () => {
    const admission = new ReplayAdmission(10, 10);
    const r1 = await admission.acquire(6, never);
    const abort = new AbortController();
    const big = admission.acquire(10, abort.signal);
    const small = admission.acquire(2, never);
    await flush();
    abort.abort();
    await expect(big).rejects.toBeDefined();
    const rSmall = await small;
    expect(admission.stats()).toEqual({ used: 8, waiting: 0 });
    r1();
    rSmall();
    expect(admission.stats()).toEqual({ used: 0, waiting: 0 });
  });

  it("caps a request at the whole budget, so one huge page runs alone", async () => {
    const admission = new ReplayAdmission(10, 10);
    const r = await admission.acquire(1_000, never);
    expect(admission.stats()).toEqual({ used: 10, waiting: 0 });
    r();
    r(); // releasing twice is harmless
    expect(admission.stats()).toEqual({ used: 0, waiting: 0 });
  });
});
