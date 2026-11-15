/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  readConatPersistMetrics,
  summarizeConatPersistDiagnostics,
} from "./conat-persist-metrics";

const DIAGNOSTICS = {
  schema_version: 1,
  collected_at: "2026-07-27T20:00:00.000Z",
  ready: true,
  server_id: "0",
  process: {
    pid: 123,
    uptime_seconds: 456,
    memory: {
      rss: 500,
      heapTotal: 300,
      heapUsed: 200,
      external: 20,
      arrayBuffers: 10,
    },
    event_loop_utilization: { utilization: 0.25 },
  },
  v8: {
    heap: { heap_size_limit: 1_000 },
    heap_spaces: [
      { space_name: "old_space", space_used_size: 100 },
      { space_name: "large_object_space", space_used_size: 40 },
      { space_name: "new_large_object_space", space_used_size: 5 },
    ],
  },
  conat: {
    local_client_subscriptions: 12,
    persistence: {
      local_streams: {
        opened_total: 80,
        closed_total: 20,
        open_total: 60,
        open_ephemeral: 10,
        open_disk: 50,
        cached_streams: 60,
        cached_references: 62,
        max_cached_references: 2,
      },
      maintenance: {
        enabled: true,
        catalog_healthy: true,
        tracking_coverage: true,
        open_paths: 50,
        present_databases: 70,
        missing_databases: 2,
        unverified_databases: 3,
        present_file_bytes: 90_000,
        present_wal_bytes: 8_000,
        last_scan_completed_at_ms: 123_456,
        scanned_files: 70,
      },
    },
  },
};

describe("project-host conat-persist metric reader", () => {
  it("reduces detailed diagnostics to a stable bounded summary", () => {
    expect(summarizeConatPersistDiagnostics(DIAGNOSTICS, 17)).toEqual({
      schema_version: 1,
      collected_at: "2026-07-27T20:00:00.000Z",
      available: true,
      ready: true,
      server_id: "0",
      pid: 123,
      uptime_seconds: 456,
      rss_bytes: 500,
      heap_total_bytes: 300,
      heap_used_bytes: 200,
      external_bytes: 20,
      array_buffers_bytes: 10,
      v8_heap_limit_bytes: 1_000,
      v8_large_object_space_used_bytes: 45,
      event_loop_utilization: 0.25,
      local_client_subscriptions: 12,
      opened_streams_total: 80,
      closed_streams_total: 20,
      open_streams: 60,
      open_ephemeral_streams: 10,
      open_disk_streams: 50,
      cached_streams: 60,
      cached_references: 62,
      max_cached_references: 2,
      maintenance_enabled: true,
      maintenance_catalog_healthy: true,
      maintenance_tracking_coverage: true,
      maintenance_open_paths: 50,
      maintenance_present_databases: 70,
      maintenance_missing_databases: 2,
      maintenance_unverified_databases: 3,
      maintenance_present_file_bytes: 90_000,
      maintenance_present_wal_bytes: 8_000,
      maintenance_last_scan_completed_at_ms: 123_456,
      maintenance_scanned_files: 70,
      diagnostics_duration_ms: 17,
    });
  });

  it("carries only a fixed class for the maintenance error, never its text", () => {
    const project = "aaaaaaaa-0890-4000-8000-000000000089";
    const path = `/mnt/cocalc/data/sync/projects/${project}/abc.db`;
    for (const [text, cls] of [
      [`persist maintenance write not proven complete: ${path}: busy`, "unproven"],
      [`promotion barrier: WAL checkpoint incomplete (busy=1 log=3 checkpointed=0) ${path}`, "checkpoint-incomplete"],
      [`fsync ${path}: EIO`, "fsync"],
      [`SQLite maintenance worker timed out after 60000ms ${path}`, "timeout"],
      [`persist maintenance open refused: the stream is poisoned: ${path}`, "refused"],
      [`something else entirely at ${path}`, "other"],
    ] as const) {
      const summary = summarizeConatPersistDiagnostics(
        {
          ...DIAGNOSTICS,
          conat: {
            ...DIAGNOSTICS.conat,
            persistence: {
              ...DIAGNOSTICS.conat.persistence,
              maintenance: { enabled: true, last_error: text },
            },
          },
        },
        5,
      );
      expect(summary.maintenance_last_error).toBe(cls);
      const all = JSON.stringify(summary);
      expect(all).not.toContain(project);
      expect(all).not.toContain("/mnt/cocalc");
      expect(all).not.toContain("abc.db");
    }
  });

  it("fetches loopback diagnostics and suppresses collection when disabled", async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      json: async () => DIAGNOSTICS,
    }));
    expect(
      await readConatPersistMetrics({
        enabled: false,
        fetchImpl: fetchImpl as any,
      }),
    ).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();

    const result = await readConatPersistMetrics({
      enabled: true,
      host: "0.0.0.0",
      port: 9202,
      fetchImpl: fetchImpl as any,
    });
    expect(result).toMatchObject({
      available: true,
      pid: 123,
      open_disk_streams: 50,
    });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "http://127.0.0.1:9202/diagnostics",
    );
  });

  it("returns a bounded unavailable sample instead of failing host metrics", async () => {
    const result = await readConatPersistMetrics({
      enabled: true,
      port: 9202,
      fetchImpl: jest.fn(async () => {
        throw new Error("connection refused\nprivate detail");
      }) as any,
    });

    expect(result).toMatchObject({
      available: false,
      schema_version: 1,
    });
    expect(result?.error).toBe("Error: connection refused private detail");
  });
});
