/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import { uuid } from "@cocalc/util/misc";
import {
  clearProjectHostMetrics,
  getProjectHostStoragePressureWindows,
  loadProjectHostMetricsHistory,
  pruneProjectHostMetricsSamples,
  recordProjectHostMetricsSample,
} from "./project-host-metrics";

describe("project host metrics history", () => {
  async function insertProjectHost(host_id: string): Promise<void> {
    await getPool().query(
      "INSERT INTO project_hosts (id, name, created, updated) VALUES ($1, $2, NOW(), NOW())",
      [host_id, `host-${host_id.slice(0, 8)}`],
    );
  }

  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  afterEach(async () => {
    await getPool().query("DELETE FROM project_host_metrics_samples");
    await getPool().query("DELETE FROM projects WHERE title='pressure test'");
    await getPool().query("DELETE FROM project_hosts");
  });

  afterAll(async () => {
    await testCleanup();
  });

  it("measures storage pressure time from bounded host samples", async () => {
    const host_id = uuid();
    const project_id = uuid();
    await insertProjectHost(host_id);
    await getPool().query(
      "UPDATE project_hosts SET bay_id='bay-0' WHERE id=$1",
      [host_id],
    );
    await getPool().query(
      "INSERT INTO projects (project_id, title, host_id, provisioned, deleted) VALUES ($1, 'pressure test', $2, true, false)",
      [project_id, host_id],
    );
    const now = Date.now();
    for (const [minutes, pressure_state] of [
      [8, "normal"],
      [6, "contended"],
      [4, "emergency"],
      [2, "recovery"],
    ] as const) {
      const collected_at = new Date(now - minutes * 60_000).toISOString();
      await recordProjectHostMetricsSample({
        host_id,
        metrics: {
          collected_at,
          storage_admission: {
            schema_version: 1,
            collected_at,
            mode: "enforce",
            pressure_state,
            state_since: collected_at,
            lifecycle_active: 0,
            starting_projects: 0,
            stopping_projects: 0,
            active_by_priority: {
              lifecycle: 0,
              interactive: 0,
              scheduled: 0,
              scavenger: 0,
            },
            btrfs_mutation_locks: 0,
            btrfs_mutation_waiters: 0,
            admitted_total: 0,
            deferred_total: 0,
            observed_deferral_total: 0,
            transition_count: 0,
          },
        },
      });
    }
    await getPool().query(
      `INSERT INTO project_host_metrics_samples
         (host_id, collected_at, storage_pressure_state,
          storage_admission_mode, storage_pressure_sample_failed)
       VALUES ($1, now() - interval '30 seconds', 'normal', 'enforce', true)`,
      [host_id],
    );
    const [window] = await getProjectHostStoragePressureWindows({
      bay_id: "bay-0",
    });
    expect(window.host_id).toBe(host_id);
    expect(window.sample_count).toBe(5);
    expect(window.contended_seconds).toBeGreaterThanOrEqual(119);
    expect(window.emergency_seconds).toBeGreaterThanOrEqual(119);
    expect(window.recovery_seconds).toBeGreaterThanOrEqual(89);
    expect(window.unavailable_seconds).toBeGreaterThanOrEqual(29);
    expect(Date.parse(window.latest_sample_at!)).toBeGreaterThan(
      Date.parse(window.latest_valid_sample_at!),
    );
  });

  it("stores at most one sample per minute and loads history with growth", async () => {
    const host_id = uuid();
    await insertProjectHost(host_id);
    const first = new Date(Date.now() - 25 * 60 * 1000);
    const second = new Date(first.getTime() + 30 * 1000);
    const third = new Date(first.getTime() + 20 * 60 * 1000);

    await recordProjectHostMetricsSample({
      host_id,
      metrics: {
        collected_at: first.toISOString(),
        cpu_percent: 10,
        memory_used_percent: 40,
        root_disk_total_bytes: 25 * 1024 ** 3,
        root_disk_used_bytes: 15 * 1024 ** 3,
        root_disk_available_bytes: 10 * 1024 ** 3,
        root_disk_used_percent: 60,
        disk_device_total_bytes: 1000,
        disk_device_used_bytes: 400,
        disk_available_conservative_bytes: 600,
        btrfs_metadata_total_bytes: 100,
        btrfs_metadata_used_bytes: 20,
        running_project_count: 2,
        conat_persist: {
          schema_version: 1,
          collected_at: first.toISOString(),
          available: true,
          ready: true,
          pid: 123,
          rss_bytes: 400 * 1024 ** 2,
          open_streams: 500,
          open_disk_streams: 490,
          open_ephemeral_streams: 10,
        },
        io_containment: {
          collected_at: first.toISOString(),
          policy: {
            version: 1,
            mode: "enforce",
            profile: "test-profile",
            capacity_source: "test",
            mountpoint: "/mnt/cocalc",
          },
          capability: {
            available: true,
            enabled: true,
            validated: true,
          },
          devices: [],
          pressure: {},
          pool_io_max: "8:16 rbps=1 wbps=1 riops=1 wiops=1",
          projects: [],
          sampled_project_count: 0,
          total_project_count: 0,
          truncated: false,
        },
      },
    });

    await recordProjectHostMetricsSample({
      host_id,
      metrics: {
        collected_at: second.toISOString(),
        cpu_percent: 20,
        memory_used_percent: 45,
        disk_device_total_bytes: 1000,
        disk_device_used_bytes: 450,
        disk_available_conservative_bytes: 550,
        btrfs_metadata_total_bytes: 100,
        btrfs_metadata_used_bytes: 25,
        running_project_count: 3,
      },
    });

    await recordProjectHostMetricsSample({
      host_id,
      metrics: {
        collected_at: third.toISOString(),
        cpu_percent: 30,
        memory_used_percent: 50,
        disk_device_total_bytes: 1000,
        disk_device_used_bytes: 700,
        disk_available_conservative_bytes: 300,
        btrfs_metadata_total_bytes: 100,
        btrfs_metadata_used_bytes: 40,
        running_project_count: 4,
      },
    });

    const history = await loadProjectHostMetricsHistory({
      host_ids: [host_id],
      window_minutes: 24 * 60,
      max_points: 60,
    });
    const entry = history.get(host_id);
    expect(entry).toBeDefined();
    expect(entry?.point_count).toBe(2);
    expect(entry?.points).toHaveLength(2);
    expect(entry?.points[0].cpu_percent).toBe(10);
    expect(entry?.points[0]).toMatchObject({
      root_disk_total_bytes: 25 * 1024 ** 3,
      root_disk_used_bytes: 15 * 1024 ** 3,
      root_disk_available_bytes: 10 * 1024 ** 3,
      root_disk_used_percent: 60,
    });
    expect(entry?.points[0].io_containment?.policy.profile).toBe(
      "test-profile",
    );
    expect(entry?.points[0].conat_persist).toMatchObject({
      available: true,
      pid: 123,
      rss_bytes: 400 * 1024 ** 2,
      open_streams: 500,
    });
    expect(entry?.points[1].cpu_percent).toBe(30);
    expect(entry?.points[0].disk_used_percent).toBe(40);
    expect(entry?.points[1].disk_used_percent).toBe(70);
    expect(entry?.growth?.disk_used_bytes_per_hour).toBeCloseTo(900, 4);
    expect(entry?.growth?.metadata_used_bytes_per_hour).toBeCloseTo(60, 4);
    expect(entry?.derived?.disk.level).toBe("critical");
    expect(entry?.derived?.metadata.level).toBe("critical");
    expect(entry?.derived?.admission_allowed).toBe(false);
    expect(entry?.derived?.alerts).toHaveLength(2);
    expect(entry?.derived?.disk.hours_to_exhaustion).toBeCloseTo(300 / 900, 4);
  });

  it("treats missing btrfs metadata fields as unavailable instead of zero", async () => {
    const host_id = uuid();
    await insertProjectHost(host_id);
    const collected_at = new Date().toISOString();

    await recordProjectHostMetricsSample({
      host_id,
      metrics: {
        collected_at,
        cpu_percent: 5,
        disk_device_total_bytes: 214748364800,
        disk_device_used_bytes: 53123457024,
        disk_available_conservative_bytes: 160854908928,
        running_project_count: 10,
      },
    });

    const history = await loadProjectHostMetricsHistory({
      host_ids: [host_id],
      window_minutes: 60,
      max_points: 60,
    });
    const entry = history.get(host_id);
    expect(entry).toBeDefined();
    expect(entry?.points).toHaveLength(1);
    expect(entry?.points[0].btrfs_metadata_total_bytes).toBeUndefined();
    expect(entry?.points[0].btrfs_metadata_used_bytes).toBeUndefined();
    expect(entry?.points[0].disk_used_percent).toBeCloseTo(24.7, 1);
    expect(entry?.derived?.metadata.level).toBe("healthy");
    expect(entry?.derived?.metadata.available_bytes).toBe(160854908928);
    expect(entry?.derived?.admission_allowed).toBe(true);
  });

  it("does not mark a mostly empty small shared scratch disk critical", async () => {
    const host_id = uuid();
    await insertProjectHost(host_id);
    const gib = 1024 ** 3;

    await recordProjectHostMetricsSample({
      host_id,
      metrics: {
        collected_at: new Date().toISOString(),
        disk_device_total_bytes: 200 * gib,
        disk_device_used_bytes: 50 * gib,
        disk_available_conservative_bytes: 150 * gib,
        shared_scratch_total_bytes: 10 * gib,
        shared_scratch_used_bytes: 0,
        shared_scratch_available_bytes: 10 * gib,
      },
    });

    const history = await loadProjectHostMetricsHistory({
      host_ids: [host_id],
      window_minutes: 60,
      max_points: 60,
    });
    const entry = history.get(host_id);
    expect(entry).toBeDefined();
    expect(entry?.points[0].shared_scratch_used_percent).toBe(0);
    expect(entry?.derived?.shared_scratch?.level).toBe("healthy");
    expect(entry?.derived?.admission_allowed).toBe(true);
  });

  it("uses effective disk headroom for admission when btrfs conservative free is low", async () => {
    const host_id = uuid();
    await insertProjectHost(host_id);
    const gib = 1024 ** 3;

    await recordProjectHostMetricsSample({
      host_id,
      metrics: {
        collected_at: new Date().toISOString(),
        disk_device_total_bytes: 250 * gib,
        disk_device_used_bytes: 134 * gib,
        disk_available_conservative_bytes: 4 * gib,
        disk_available_for_admission_bytes: 116 * gib,
      },
    });

    const history = await loadProjectHostMetricsHistory({
      host_ids: [host_id],
      window_minutes: 60,
      max_points: 60,
    });
    const entry = history.get(host_id);
    expect(entry).toBeDefined();
    expect(entry?.points[0].disk_used_percent).toBeCloseTo(53.6, 1);
    expect(entry?.derived?.disk.level).toBe("healthy");
    expect(entry?.derived?.disk.available_bytes).toBe(116 * gib);
    expect(entry?.derived?.admission_allowed).toBe(true);
  });

  it("still marks shared scratch critical when low headroom combines with high usage", async () => {
    const host_id = uuid();
    await insertProjectHost(host_id);
    const gib = 1024 ** 3;

    await recordProjectHostMetricsSample({
      host_id,
      metrics: {
        collected_at: new Date().toISOString(),
        disk_device_total_bytes: 200 * gib,
        disk_device_used_bytes: 50 * gib,
        disk_available_conservative_bytes: 150 * gib,
        shared_scratch_total_bytes: 10 * gib,
        shared_scratch_used_bytes: 7 * gib,
        shared_scratch_available_bytes: 3 * gib,
      },
    });

    const history = await loadProjectHostMetricsHistory({
      host_ids: [host_id],
      window_minutes: 60,
      max_points: 60,
    });
    const entry = history.get(host_id);
    expect(entry).toBeDefined();
    expect(entry?.points[0].shared_scratch_used_percent).toBe(70);
    expect(entry?.derived?.shared_scratch?.level).toBe("critical");
  });

  it("does not warn on high metadata chunk usage when device unallocated headroom is ample", async () => {
    const host_id = uuid();
    await insertProjectHost(host_id);
    const collected_at = new Date().toISOString();

    await recordProjectHostMetricsSample({
      host_id,
      metrics: {
        collected_at,
        disk_device_total_bytes: 200 * 1024 ** 3,
        disk_device_used_bytes: 60 * 1024 ** 3,
        disk_available_conservative_bytes: 140 * 1024 ** 3,
        disk_unallocated_bytes: 120 * 1024 ** 3,
        btrfs_metadata_total_bytes: 10 * 1024 ** 3,
        btrfs_metadata_used_bytes: Math.floor(8.6 * 1024 ** 3),
      },
    });

    const history = await loadProjectHostMetricsHistory({
      host_ids: [host_id],
      window_minutes: 60,
      max_points: 60,
    });
    const entry = history.get(host_id);
    expect(entry).toBeDefined();
    expect(entry?.derived?.metadata.level).toBe("healthy");
    expect(entry?.derived?.metadata.available_bytes).toBeCloseTo(
      121.4 * 1024 ** 3,
      0,
    );
    expect(entry?.derived?.admission_allowed).toBe(true);
  });

  it("ignores reservation-backed pull spikes when computing growth forecasts", async () => {
    const host_id = uuid();
    await insertProjectHost(host_id);
    const start = new Date(Date.now() - 10 * 60 * 1000);
    const gib = 1024 ** 3;
    const samples = [
      { minute: 0, used: 40 * gib, avail: 160 * gib, reservation: 0 },
      { minute: 1, used: 42 * gib, avail: 158 * gib, reservation: 20 * gib },
      { minute: 2, used: 80 * gib, avail: 120 * gib, reservation: 20 * gib },
      { minute: 3, used: 110 * gib, avail: 90 * gib, reservation: 20 * gib },
      { minute: 4, used: 110 * gib, avail: 90 * gib, reservation: 0 },
      { minute: 5, used: 110 * gib, avail: 90 * gib, reservation: 0 },
      { minute: 6, used: 110 * gib, avail: 90 * gib, reservation: 0 },
      { minute: 7, used: 110 * gib, avail: 90 * gib, reservation: 0 },
    ];

    for (const sample of samples) {
      await recordProjectHostMetricsSample({
        host_id,
        metrics: {
          collected_at: new Date(
            start.getTime() + sample.minute * 61 * 1000,
          ).toISOString(),
          disk_device_total_bytes: 200 * gib,
          disk_device_used_bytes: sample.used,
          disk_available_conservative_bytes: sample.avail,
          reservation_bytes: sample.reservation,
        },
      });
    }

    const history = await loadProjectHostMetricsHistory({
      host_ids: [host_id],
      window_minutes: 60,
      max_points: 60,
    });
    const entry = history.get(host_id);
    expect(entry).toBeDefined();
    expect(entry?.growth?.disk_used_bytes_per_hour).toBeUndefined();
    expect(entry?.derived?.disk.hours_to_exhaustion).toBeUndefined();
    expect(entry?.derived?.disk.level).toBe("healthy");
    expect(entry?.derived?.admission_allowed).toBe(true);
  });

  it("still forecasts sustained non-reservation disk growth", async () => {
    const host_id = uuid();
    await insertProjectHost(host_id);
    const start = new Date(Date.now() - 30 * 60 * 1000);
    const gib = 1024 ** 3;

    for (let minute = 0; minute < 8; minute += 1) {
      const used = (60 + minute * 5) * gib;
      await recordProjectHostMetricsSample({
        host_id,
        metrics: {
          collected_at: new Date(
            start.getTime() + minute * 3 * 60 * 1000,
          ).toISOString(),
          disk_device_total_bytes: 100 * gib,
          disk_device_used_bytes: used,
          disk_available_conservative_bytes: 100 * gib - used,
          reservation_bytes: 0,
        },
      });
    }

    const history = await loadProjectHostMetricsHistory({
      host_ids: [host_id],
      window_minutes: 60,
      max_points: 60,
    });
    const entry = history.get(host_id);
    expect(entry).toBeDefined();
    expect(entry?.growth?.disk_used_bytes_per_hour).toBeGreaterThan(0);
    expect(entry?.derived?.disk.hours_to_exhaustion).toBeGreaterThan(0);
  });

  it("does not forecast growth from only a few minutes of fresh-host samples", async () => {
    const host_id = uuid();
    await insertProjectHost(host_id);
    const start = new Date(Date.now() - 8 * 60 * 1000);
    const mib = 1024 ** 2;

    const samples = [
      {
        minute: 0,
        disk_used: 1 * mib,
        disk_avail: 50 * 1024 ** 3,
        metadata_used: 144 * 1024,
        reservation: 0,
      },
      {
        minute: 1,
        disk_used: 7 * mib,
        disk_avail: 49.99 * 1024 ** 3,
        metadata_used: 320 * 1024,
        reservation: 0,
      },
      {
        minute: 2.5,
        disk_used: 290 * mib,
        disk_avail: 50.25 * 1024 ** 3,
        metadata_used: 9 * mib,
        reservation: 5 * 1024 ** 3,
      },
      {
        minute: 3.5,
        disk_used: 287 * mib,
        disk_avail: 50.22 * 1024 ** 3,
        metadata_used: 9.2 * mib,
        reservation: 0,
      },
      {
        minute: 5,
        disk_used: 1335 * mib,
        disk_avail: 49.25 * 1024 ** 3,
        metadata_used: 9.2 * mib,
        reservation: 0,
      },
      {
        minute: 6,
        disk_used: 1488 * mib,
        disk_avail: 49.06 * 1024 ** 3,
        metadata_used: 16.8 * mib,
        reservation: 0,
      },
      {
        minute: 7.5,
        disk_used: 1388 * mib,
        disk_avail: 49.17 * 1024 ** 3,
        metadata_used: 13.7 * mib,
        reservation: 0,
      },
    ];

    for (const sample of samples) {
      await recordProjectHostMetricsSample({
        host_id,
        metrics: {
          collected_at: new Date(
            start.getTime() + sample.minute * 60 * 1000,
          ).toISOString(),
          disk_device_total_bytes: 100 * 1024 ** 3,
          disk_device_used_bytes: Math.round(sample.disk_used),
          disk_available_conservative_bytes: Math.round(sample.disk_avail),
          btrfs_metadata_total_bytes: 1 * 1024 ** 3,
          btrfs_metadata_used_bytes: Math.round(sample.metadata_used),
          reservation_bytes: sample.reservation,
        },
      });
    }

    const history = await loadProjectHostMetricsHistory({
      host_ids: [host_id],
      window_minutes: 60,
      max_points: 60,
    });
    const entry = history.get(host_id);
    expect(entry).toBeDefined();
    expect(entry?.growth?.disk_used_bytes_per_hour).toBeUndefined();
    expect(entry?.growth?.metadata_used_bytes_per_hour).toBeUndefined();
    expect(entry?.derived?.disk.hours_to_exhaustion).toBeUndefined();
    expect(entry?.derived?.metadata.hours_to_exhaustion).toBeUndefined();
    expect(entry?.derived?.disk.level).toBe("healthy");
    expect(entry?.derived?.metadata.level).toBe("healthy");
    expect(entry?.derived?.admission_allowed).toBe(true);
    expect(entry?.derived?.auto_grow_recommended).toBe(false);
  });

  it("clears stored metrics history for a host", async () => {
    const host_id = uuid();
    await insertProjectHost(host_id);

    await recordProjectHostMetricsSample({
      host_id,
      metrics: {
        collected_at: new Date().toISOString(),
        cpu_percent: 1,
        disk_device_total_bytes: 1000,
        disk_device_used_bytes: 10,
        disk_available_conservative_bytes: 990,
      },
    });

    await clearProjectHostMetrics({ host_id });

    const history = await loadProjectHostMetricsHistory({
      host_ids: [host_id],
      window_minutes: 60,
      max_points: 60,
    });
    const entry = history.get(host_id);
    expect(entry?.point_count).toBe(0);
    expect(entry?.points).toEqual([]);
    expect(entry?.growth).toBeUndefined();
    expect(entry?.derived).toBeUndefined();
  });

  it("prunes old samples in bounded batches", async () => {
    const host_id = uuid();
    await insertProjectHost(host_id);
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const recent = new Date();

    for (const collected_at of [old, recent]) {
      await recordProjectHostMetricsSample({
        host_id,
        metrics: {
          collected_at: collected_at.toISOString(),
          cpu_percent: 1,
        },
      });
    }

    expect(
      await pruneProjectHostMetricsSamples({
        before: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
        limit: 1,
      }),
    ).toBe(1);
    const { rows } = await getPool().query(
      "SELECT collected_at FROM project_host_metrics_samples WHERE host_id=$1",
      [host_id],
    );
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].collected_at).getTime()).toBeGreaterThan(
      recent.getTime() - 60_000,
    );
  });
});
