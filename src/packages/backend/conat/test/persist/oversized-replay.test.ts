/*
A stream holding a huge message must not monopolize the persist server, and a
requester with a short idle timeout must not keep restarting its replay.  In
production a 500 MB runaway notebook output saved as one patch made a host's
persist daemon stall for 7-8 s out of every 8 s: each replay decompressed it
synchronously and the browser, timing out after 2.5 s, asked again.

pnpm test ./oversized-replay.test.ts
*/

import { promisify } from "node:util";
import {
  zstdCompressSync,
  zstdDecompressSync,
  zstdDecompress,
} from "node:zlib";
import sqlite from "node:sqlite";
import { statSync, copyFileSync } from "node:fs";
import { before, after, connect } from "@cocalc/backend/conat/test/setup";
import { initContext, syncFiles } from "@cocalc/conat/persist/context";
import ensureContainingDirectoryExists from "@cocalc/backend/misc/ensure-containing-directory-exists";
import { stream } from "@cocalc/conat/persist/client";
import { dstream } from "@cocalc/backend/conat/sync";
import { messageData, DataEncoding } from "@cocalc/conat/core/client";
import { pstream } from "@cocalc/backend/conat/persist";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

beforeAll(before);
afterAll(after);

jest.setTimeout(30000);

const SLOW_DECOMPRESS_MS = 1500;

function useDecompressAsync(fn: (buf: Buffer) => Promise<Buffer>) {
  initContext({
    sqlite,
    compress: zstdCompressSync,
    decompress: zstdDecompressSync,
    decompressAsync: fn,
    syncFiles: { ...syncFiles },
    ensureContainingDirectoryExists,
    statSync,
    copyFileSync,
  });
}

const fastDecompress = promisify(zstdDecompress);

describe("replaying a stream with a large message", () => {
  let client, big, other;

  afterAll(() => {
    useDecompressAsync(fastDecompress);
  });

  it("writes a large compressible message and a small stream", async () => {
    client = connect();
    big = stream({
      client,
      user: { hub_id: "x" },
      storage: { path: "hub/oversized-replay-big" },
    });
    other = stream({
      client,
      user: { hub_id: "x" },
      storage: { path: "hub/oversized-replay-other" },
    });
    await big.set({ messageData: messageData("small") });
    await big.set({ messageData: messageData("x".repeat(3_000_000)) });
    await other.set({ key: "k", messageData: messageData("v") });
  });

  it("keeps a short-timeout replay alive and serves other streams meanwhile", async () => {
    useDecompressAsync(async (buf) => {
      await new Promise((resolve) => setTimeout(resolve, SLOW_DECOMPRESS_MS));
      return await fastDecompress(buf);
    });
    const started = Date.now();
    const chunks: number[] = [];
    const replayDone = (async () => {
      // 500 ms idle timeout, far less than the decompression takes
      for await (const chunk of big.getAllIter({ timeout: 500 })) {
        chunks.push(chunk.length);
      }
    })();
    // While the large message is being decompressed, another stream on the
    // same server answers promptly.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const t0 = Date.now();
    expect((await other.get({ key: "k" })).data).toBe("v");
    expect(Date.now() - t0).toBeLessThan(500);
    expect(Date.now() - started).toBeLessThan(SLOW_DECOMPRESS_MS);

    await replayDone;
    expect(Date.now() - started).toBeGreaterThanOrEqual(SLOW_DECOMPRESS_MS);
    // empty keepalive chunks arrived while waiting, then both messages
    expect(chunks.filter((n) => n == 0).length).toBeGreaterThan(0);
    expect(chunks.reduce((a, b) => a + b, 0)).toBe(2);
  });
});

describe("message size limit", () => {
  let client, s;

  afterEach(() => {
    delete process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES;
  });

  it("refuses to replay a stream holding a message over the limit", async () => {
    client = connect();
    s = stream({
      client,
      user: { hub_id: "x" },
      storage: { path: "hub/oversized-limit" },
    });
    await s.set({ messageData: messageData("x".repeat(500_000)) });
    process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES = "100000";
    await expect(s.getAll({ timeout: 5000 })).rejects.toMatchObject({
      code: 413,
    });
    delete process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES;
    expect(await s.getAll({ timeout: 5000 })).toHaveLength(1);
  });

  it("says which message, and in which history epoch (H1b-4: a later reset is a recovery)", async () => {
    const s = stream({
      client: connect(),
      user: { hub_id: "x" },
      storage: { path: `hub/oversized-epoch-${Math.random()}` },
    });
    await s.set({ messageData: messageData("small") });
    const reset = await s.resetHistory({});
    expect(reset.history_epoch).toBeGreaterThan(0);
    // written in the new history (its fence requires the epoch)
    const { seq } = await s.set({
      messageData: messageData("x".repeat(500_000), {
        headers: { history_epoch: reset.history_epoch },
      }),
    });
    process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES = "100000";
    await expect(s.getAll({ timeout: 5000 })).rejects.toMatchObject({
      code: 413,
      oversizedSeq: seq,
      oversizedEpoch: reset.history_epoch,
    });
  });
});

describe("a message written during a replay", () => {
  let client, s;

  afterAll(() => {
    useDecompressAsync(fastDecompress);
  });

  it("is delivered exactly once: by the changefeed, not also by the replay", async () => {
    client = connect();
    s = stream({
      client,
      user: { hub_id: "x" },
      storage: { path: `hub/replay-exactly-once-${Math.random()}` },
    });
    // a large message makes the replay pause on its decompression
    await s.set({ messageData: messageData("x".repeat(3_000_000)) });
    await s.set({ messageData: messageData("small") });
    const cf = await s.changefeed();
    useDecompressAsync(async (buf) => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return await fastDecompress(buf);
    });

    const replayed = s.getAll({ changefeed: true, timeout: 500 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const { seq: appended } = await s.set({
      messageData: messageData("written during the replay"),
    });

    const seqs = (await replayed).map((m) => m.seq);
    expect(seqs).toEqual([1, 2]);
    const { value: updates } = await cf.next();
    expect(updates.map((u) => u.seq)).toEqual([appended]);
    cf.close?.();
  });
});

describe("opening a sync stream that holds a message over the limit", () => {
  const name = `oversized-dstream-${Math.random()}`;

  afterEach(() => {
    delete process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES;
  });

  it("fails promptly with 413 instead of retrying forever", async () => {
    const s = await dstream<string>({ name, noCache: true });
    s.publish("x".repeat(500_000));
    await s.save();
    s.close();

    process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES = "100000";
    const t0 = Date.now();
    await expect(
      dstream<string>({ name, noCache: true }),
    ).rejects.toMatchObject({ code: 413 });
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe("reading one message over the limit", () => {
  afterEach(() => {
    delete process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES;
  });

  it("refuses before reading its data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "persist-oversized-get-"));
    try {
      const s = pstream({ path: join(dir, "stream") });
      s.set({
        key: "big",
        encoding: DataEncoding.JsonCodec,
        raw: Buffer.from("x".repeat(500_000)),
      });
      process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES = "100000";
      const db = (s as any).db;
      const prepare = db.prepare.bind(db);
      const queries: string[] = [];
      db.prepare = (sql: string) => {
        queries.push(sql);
        return prepare(sql);
      };
      expect(() => s.get({ key: "big", seq: undefined })).toThrow(
        expect.objectContaining({ code: 413 }),
      );
      expect(queries.length).toBeGreaterThan(0);
      // length(raw) and typeof(raw) read only the stored length and type,
      // not the data
      expect(
        queries.some((q) =>
          /\braw\b/.test(q.replace(/(length|typeof)\(raw\)/g, "")),
        ),
      ).toBe(false);
      db.prepare = prepare;
      s.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
