/*
Finding 028 B-2: the keep-open registry (DESIGN v1.21 §4 items 8-10).

A disk stream whose final checkpoint fails without a sync error (e.g., its
project is at quota) is NOT closed: it stays open and intact, counts as open
for the project fence, is retried with backoff, and the next get re-adopts
it.  A retry never acts on a stream that was re-adopted meanwhile.
*/

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pstream } from "@cocalc/backend/conat/persist";
import { DataEncoding } from "@cocalc/conat/core/client";
import {
  PARK_RETRY_INITIAL_MS,
  PersistentStream,
  openDiskStreamPaths,
  attemptParkedCloseForTests,
  parkedGenerationForTests,
  parkedStreamPaths,
  retryParkedStreams,
} from "@cocalc/conat/persist/storage";

const msg = (s: string, extra: object = {}) => ({
  encoding: DataEncoding.JsonCodec,
  raw: Buffer.from(s),
  ...extra,
});

function rows(stream): number {
  return Number(
    ((stream as any).db.prepare("SELECT COUNT(*) AS n FROM messages").get() as any)
      .n,
  );
}

// make the stream's next checkpoint(s) fail like a user at quota
function failCheckpoints(stream) {
  return jest.spyOn(stream, "checkpointOutcome").mockReturnValue("error");
}

describe("028 B-2: the keep-open registry", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "persist-028-park-"));
  });
  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    retryParkedStreams(() => true);
    await rm(dir, { recursive: true, force: true });
  });

  it("a failed final checkpoint keeps the connection open, intact and counted for the fence", () => {
    const path = join(dir, "quota");
    const s = pstream({ path });
    s.set(msg("a"));
    failCheckpoints(s);
    s.close();
    expect(parkedStreamPaths()).toContain(path);
    expect(openDiskStreamPaths()).toContain(path);
    // not torn down: still readable
    expect((s as any).db.isOpen).toBe(true);
    expect(rows(s)).toBe(1);
  });

  it("the next get re-adopts the same object: reads, writes and msgID dedupe still work", async () => {
    const path = join(dir, "adopt");
    const s = pstream({ path });
    const first = await s.setQueued(msg("a", { msgID: "m1" }));
    failCheckpoints(s);
    s.close();
    jest.restoreAllMocks();
    const again = pstream({ path });
    expect(again).toBe(s);
    expect(parkedStreamPaths()).not.toContain(path);
    expect(await again.setQueued(msg("a", { msgID: "m1" }))).toEqual(first);
    await again.setQueued(msg("b"));
    expect(rows(again)).toBe(2);
    // and its close works normally now
    again.close();
    expect(openDiskStreamPaths()).not.toContain(path);
  });

  it("a retry after the space came back closes it, and the fence no longer sees it", () => {
    const path = join(dir, "retry");
    const s = pstream({ path });
    s.set(msg("a"));
    const spy = failCheckpoints(s);
    s.close();
    retryParkedStreams((p) => p === path); // still failing
    expect(parkedStreamPaths()).toContain(path);
    spy.mockRestore();
    retryParkedStreams((p) => p === path);
    expect(parkedStreamPaths()).not.toContain(path);
    expect(openDiskStreamPaths()).not.toContain(path);
    expect((s as any).db?.isOpen ?? false).toBe(false);
  });

  it("re-adoption wins over a retry: a retry of an adopted stream does nothing", () => {
    const path = join(dir, "race");
    const s = pstream({ path });
    s.set(msg("a"));
    failCheckpoints(s);
    s.close();
    jest.restoreAllMocks();
    const adopted = pstream({ path });
    retryParkedStreams(() => true);
    expect((adopted as any).db.isOpen).toBe(true);
    adopted.set(msg("b"));
    expect(rows(adopted)).toBe(2);
    adopted.close();
  });

  it("a STALE retry (its generation from before an adoption and a new park) does nothing (SA-B2-2 e)", () => {
    const path = join(dir, "stale");
    const s = pstream({ path });
    s.set(msg("a"));
    failCheckpoints(s);
    s.close(); // parked (generation g1)
    const stale = parkedGenerationForTests(path)!;
    jest.restoreAllMocks();
    const adopted = pstream({ path }); // re-adopted: g1 is stale now
    failCheckpoints(adopted);
    adopted.close(); // parked AGAIN: a new entry, a new generation
    jest.restoreAllMocks();
    expect(parkedGenerationForTests(path)).not.toBe(stale);
    // the stale retry must not act on the new entry
    expect(attemptParkedCloseForTests(path, stale)).toBe(false);
    expect(parkedStreamPaths()).toContain(path);
    expect((adopted as any).db.isOpen).toBe(true);
    // the current generation's retry does close it
    expect(attemptParkedCloseForTests(path, parkedGenerationForTests(path)!)).toBe(true);
    expect(parkedStreamPaths()).not.toContain(path);
  });

  it("no second connection to a parked path: a direct construction is refused", () => {
    const path = join(dir, "second");
    const s = pstream({ path });
    failCheckpoints(s);
    s.close();
    expect(() => new PersistentStream({ path })).toThrow("still closing");
  });

  it("retries on its own with backoff, without any other event", () => {
    jest.useFakeTimers();
    const path = join(dir, "backoff");
    const s = pstream({ path });
    s.set(msg("a"));
    const spy = failCheckpoints(s);
    s.close();
    const calls = spy.mock.calls.length;
    jest.advanceTimersByTime(PARK_RETRY_INITIAL_MS);
    expect(spy.mock.calls.length).toBe(calls + 1);
    // doubled: nothing at the initial delay again
    jest.advanceTimersByTime(PARK_RETRY_INITIAL_MS);
    expect(spy.mock.calls.length).toBe(calls + 1);
    spy.mockRestore();
    jest.advanceTimersByTime(PARK_RETRY_INITIAL_MS);
    expect(parkedStreamPaths()).not.toContain(path);
  });

  it("a sync error at the final checkpoint poisons: never parked for retry, never closed", () => {
    const path = join(dir, "sync");
    const s = pstream({ path });
    s.set(msg("a"));
    const db = (s as any).db;
    const prepare = db.prepare;
    db.prepare = (sql: string, ...rest) => {
      if (sql.startsWith("PRAGMA wal_checkpoint")) {
        const err: any = new Error("disk I/O error");
        err.errcode = 1034; // SQLITE_IOERR_FSYNC
        throw err;
      }
      return prepare.call(db, sql, ...rest);
    };
    s.close();
    expect(s.isPoisoned()).toBe(true);
    expect(parkedStreamPaths()).not.toContain(path);
    expect(openDiskStreamPaths()).toContain(path);
  });
});
