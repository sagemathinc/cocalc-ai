/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import { uuid } from "@cocalc/util/misc";
import {
  clearProjectHostMetrics,
  loadProjectHostMetricsHistory,
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
    await getPool().query("DELETE FROM project_hosts");
  });

  afterAll(async () => {
    await testCleanup();
  });

  it("stores at most one sample per minute and loads history with growth", async () => {
    const host_id = uuid();
    await insertProjectHost(host_id);
    const first = new Date(Date.now() - 2 * 60 * 1000);
    const second = new Date(first.getTime() + 30 * 1000);
    const third = new Date(first.getTime() + 2 * 60 * 1000);

    await recordProjectHostMetricsSample({
      host_id,
      metrics: {
        collected_at: first.toISOString(),
        cpu_percent: 10,
        memory_used_percent: 40,
        disk_device_total_bytes: 1000,
        disk_device_used_bytes: 400,
        disk_available_conservative_bytes: 600,
        btrfs_metadata_total_bytes: 100,
        btrfs_metadata_used_bytes: 20,
        running_project_count: 2,
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
    expect(entry?.points[1].cpu_percent).toBe(30);
    expect(entry?.points[0].disk_used_percent).toBe(40);
    expect(entry?.points[1].disk_used_percent).toBe(70);
    expect(entry?.growth?.disk_used_bytes_per_hour).toBeCloseTo(9000, 4);
    expect(entry?.growth?.metadata_used_bytes_per_hour).toBeCloseTo(600, 4);
    expect(entry?.derived?.disk.level).toBe("critical");
    expect(entry?.derived?.metadata.level).toBe("critical");
    expect(entry?.derived?.admission_allowed).toBe(false);
    expect(entry?.derived?.alerts).toHaveLength(2);
    expect(entry?.derived?.disk.hours_to_exhaustion).toBeCloseTo(300 / 9000, 4);
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
    expect(entry?.points[0].disk_used_percent).toBeCloseTo(25.1, 1);
    expect(entry?.derived?.metadata.level).toBe("healthy");
    expect(entry?.derived?.metadata.available_bytes).toBe(160854908928);
    expect(entry?.derived?.admission_allowed).toBe(true);
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
    const start = new Date(Date.now() - 10 * 60 * 1000);
    const gib = 1024 ** 3;

    for (let minute = 0; minute < 8; minute += 1) {
      const used = (60 + minute * 5) * gib;
      await recordProjectHostMetricsSample({
        host_id,
        metrics: {
          collected_at: new Date(
            start.getTime() + minute * 61 * 1000,
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
});
