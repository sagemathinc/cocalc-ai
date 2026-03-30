/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import { uuid } from "@cocalc/util/misc";
import {
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
  });
});
