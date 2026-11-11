import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pstream } from "@cocalc/backend/conat/persist";
import { DataEncoding } from "@cocalc/conat/core/client";
import {
  getPersistWriteStats,
  getPersistentStreamDiagnostics,
  logPersistWriteRate,
} from "@cocalc/conat/persist/storage";

describe("persist write-rate counters", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "persist-write-rate-"));
    // start each test with a fresh window
    logPersistWriteRate();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("counts committed transactions, the rows they add and their bytes", () => {
    const before = getPersistWriteStats();
    const stream = pstream({ path: join(dir, "a") });
    try {
      stream.set({
        key: "one",
        encoding: DataEncoding.JsonCodec,
        raw: Buffer.from("x".repeat(10)),
      });
      stream.setMany([
        { encoding: DataEncoding.JsonCodec, raw: Buffer.from("a") },
        { encoding: DataEncoding.JsonCodec, raw: Buffer.from("b") },
        { encoding: DataEncoding.JsonCodec, raw: Buffer.from("c") },
      ]);
      const after = getPersistWriteStats();
      // a set and a setMany each commit one transaction (opening the stream
      // may commit its own bookkeeping, hence at least two)
      expect(after.commits_total - before.commits_total).toBeGreaterThanOrEqual(
        2,
      );
      expect(after.disk_commits_total - before.disk_commits_total).toBe(
        after.commits_total - before.commits_total,
      );
      expect(after.rows_total - before.rows_total).toBe(4);
      expect(after.bytes_total - before.bytes_total).toBeGreaterThanOrEqual(13);
      expect(after.commit_ms_max).toBeGreaterThanOrEqual(0);
    } finally {
      stream.close();
    }
  });

  it("does not count a transaction that rolls back", () => {
    const stream = pstream({ path: join(dir, "b") });
    try {
      stream.config({ max_msgs: 1, discard_policy: "new" });
      stream.set({ encoding: DataEncoding.JsonCodec, raw: Buffer.from("1") });
      const before = getPersistWriteStats();
      expect(() =>
        stream.set({ encoding: DataEncoding.JsonCodec, raw: Buffer.from("2") }),
      ).toThrow();
      const after = getPersistWriteStats();
      expect(after.commits_total).toBe(before.commits_total);
      expect(after.rows_total).toBe(before.rows_total);
    } finally {
      stream.close();
    }
  });

  it("counts ephemeral streams separately", () => {
    const before = getPersistWriteStats();
    const stream = pstream({ path: join(dir, "c"), ephemeral: true });
    try {
      stream.set({ encoding: DataEncoding.JsonCodec, raw: Buffer.from("e") });
      const after = getPersistWriteStats();
      expect(
        after.ephemeral_commits_total - before.ephemeral_commits_total,
      ).toBeGreaterThanOrEqual(1);
      expect(after.disk_commits_total).toBe(before.disk_commits_total);
    } finally {
      stream.close();
    }
  });

  it("logs per-window deltas and the busiest second, then resets the window", () => {
    const stream = pstream({ path: join(dir, "d") });
    try {
      const start = Date.now();
      for (let i = 0; i < 5; i++) {
        stream.set({
          encoding: DataEncoding.JsonCodec,
          raw: Buffer.from(`${i}`),
        });
      }
      const entry = logPersistWriteRate(start + 60_000);
      expect(entry.rows).toBe(5);
      expect(entry.commits).toBeGreaterThanOrEqual(5);
      expect(entry.disk_commits).toBe(entry.commits);
      // all five ran within a test, i.e. within one or two clock seconds
      expect(entry.peak_rows_per_second).toBeGreaterThanOrEqual(3);
      expect(entry.peak_commits_per_second).toBeGreaterThanOrEqual(3);
      expect(entry.rows_per_second).toBeGreaterThan(0);
      expect(entry.commit_ms_avg).toBeGreaterThanOrEqual(0);

      const empty = logPersistWriteRate(start + 120_000);
      expect(empty.commits).toBe(0);
      expect(empty.rows).toBe(0);
      expect(empty.peak_commits_per_second).toBe(0);
    } finally {
      stream.close();
    }
  });

  it("reports the counters in the persistence diagnostics, counts only", () => {
    const diagnostics = getPersistentStreamDiagnostics();
    expect(diagnostics.write_stats).toEqual(getPersistWriteStats());
    expect(Object.keys(diagnostics.write_stats).sort()).toEqual([
      "bytes_total",
      "commit_ms_max",
      "commit_ms_total",
      "commits_total",
      "disk_commits_total",
      "ephemeral_commits_total",
      "rows_total",
    ]);
  });
});
