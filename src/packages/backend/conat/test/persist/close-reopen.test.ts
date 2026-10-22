import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pstream } from "@cocalc/backend/conat/persist";
import { DataEncoding } from "@cocalc/conat/core/client";
import {
  EPHEMERAL_SQLITE_CACHE_KIB_ENV,
  getPersistentStreamDiagnostics,
  getPersistentStreamSqliteDiagnostics,
  openDiskStreamPaths,
  openPaths,
  resolveEphemeralSqliteCacheKiB,
} from "@cocalc/conat/persist/storage";

describe("persistent stream close lifecycle", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "persist-close-reopen-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("fully closes a database before the same path can reopen", async () => {
    const path = join(dir, "stream");
    const first = pstream({ path });
    first.set({
      key: "first",
      encoding: DataEncoding.JsonCodec,
      raw: Buffer.from("one"),
    });

    first.close();
    const second = pstream({ path });
    second.set({
      key: "second",
      encoding: DataEncoding.JsonCodec,
      raw: Buffer.from("two"),
    });

    // The old async close deleted this marker after the replacement stream
    // opened, proving both connections overlapped on the same SQLite path.
    await Promise.resolve();
    expect(openPaths.has(path)).toBe(true);
    expect(second.get({ key: "first", seq: undefined })).toBeDefined();
    expect(second.get({ key: "second", seq: undefined })).toBeDefined();

    second.close();
    expect(openPaths.has(path)).toBe(false);
  });

  it("removes a maintenance owner only after the final cached reference closes", () => {
    const path = join(dir, "tracked");
    let closes = 0;
    let mutations = 0;
    const maintenance = {
      ownerId: "worker-0",
      onFinalClose: () => closes++,
      onMutation: () => mutations++,
    };
    const first = pstream({ path });
    first.addMaintenanceHandle(maintenance);
    const second = pstream({ path });
    second.addMaintenanceHandle(maintenance);
    first.set({
      key: "first",
      encoding: DataEncoding.JsonCodec,
      raw: Buffer.from("one"),
    });
    expect(mutations).toBeGreaterThan(0);

    first.close();
    expect(closes).toBe(0);
    second.close();
    expect(closes).toBe(1);
  });

  it("a database that fails to close stays open for fences", () => {
    const path = join(dir, "unclosed");
    const stream = pstream({ path, noCache: true });
    const db = (stream as any).db;
    const close = db.close.bind(db);
    db.close = () => {
      throw new Error("disk I/O error");
    };
    try {
      stream.close();
      // a fence of its project never takes it as closed (fence.ts)
      expect(openDiskStreamPaths()).toContain(path);
    } finally {
      close();
    }
  });

  it("tracks ephemeral and disk stream lifecycles without exposing paths", () => {
    const before = getPersistentStreamDiagnostics();
    const ephemeral = pstream({
      path: join(dir, "ephemeral"),
      ephemeral: true,
      noCache: true,
    });
    const disk = pstream({
      path: join(dir, "disk"),
      noCache: true,
    });

    const open = getPersistentStreamDiagnostics();
    expect(open.open_total - before.open_total).toBe(2);
    expect(open.open_ephemeral - before.open_ephemeral).toBe(1);
    expect(open.open_disk - before.open_disk).toBe(1);
    expect(open.opened_total - before.opened_total).toBe(2);
    expect(JSON.stringify(open)).not.toContain(dir);
    const sqlite = getPersistentStreamSqliteDiagnostics();
    expect(sqlite.ephemeral.databases).toBeGreaterThanOrEqual(1);
    expect(sqlite.ephemeral.live_page_bytes).toBeGreaterThan(0);
    expect(sqlite.disk.databases).toBeGreaterThanOrEqual(1);
    expect(sqlite.disk.live_page_bytes).toBeGreaterThan(0);
    expect(sqlite.disk.file_bytes).toBeGreaterThan(0);
    expect(sqlite.disk.wal_bytes).toBeGreaterThanOrEqual(0);
    expect(sqlite.disk.shm_bytes).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(sqlite)).not.toContain(dir);

    ephemeral.close();
    disk.close();
    const closed = getPersistentStreamDiagnostics();
    expect(closed.open_total).toBe(before.open_total);
    expect(closed.closed_total - before.closed_total).toBe(2);
  });

  it("validates the opt-in ephemeral SQLite cache limit", () => {
    expect(resolveEphemeralSqliteCacheKiB({})).toBeUndefined();
    expect(
      resolveEphemeralSqliteCacheKiB({
        [EPHEMERAL_SQLITE_CACHE_KIB_ENV]: "256",
      }),
    ).toBe(256);
    expect(() =>
      resolveEphemeralSqliteCacheKiB({
        [EPHEMERAL_SQLITE_CACHE_KIB_ENV]: "1.5",
      }),
    ).toThrow(EPHEMERAL_SQLITE_CACHE_KIB_ENV);
    expect(() =>
      resolveEphemeralSqliteCacheKiB({
        [EPHEMERAL_SQLITE_CACHE_KIB_ENV]: "0",
      }),
    ).toThrow(EPHEMERAL_SQLITE_CACHE_KIB_ENV);
  });

  it("applies the opt-in cache limit to new ephemeral streams", () => {
    const previous = process.env[EPHEMERAL_SQLITE_CACHE_KIB_ENV];
    process.env[EPHEMERAL_SQLITE_CACHE_KIB_ENV] = "256";
    let stream: ReturnType<typeof pstream> | undefined;
    try {
      stream = pstream({
        path: join(dir, "limited-ephemeral"),
        ephemeral: true,
        noCache: true,
      });
      const diagnostics = getPersistentStreamDiagnostics();
      expect(diagnostics.sqlite_cache.ephemeral_override_kib).toBe(256);
      expect(diagnostics.sqlite_cache.ephemeral.min_kib).toBe(256);
      expect(diagnostics.sqlite_cache.ephemeral.max_kib).toBe(256);
    } finally {
      stream?.close();
      if (previous == null) {
        delete process.env[EPHEMERAL_SQLITE_CACHE_KIB_ENV];
      } else {
        process.env[EPHEMERAL_SQLITE_CACHE_KIB_ENV] = previous;
      }
    }
  });
});
