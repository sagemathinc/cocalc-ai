/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import { uuid } from "@cocalc/util/misc";
import {
  clearProjectStorageHistory,
  loadProjectStorageHistory,
  recordProjectStorageHistorySample,
} from "./project-storage-history";

describe("project storage history", () => {
  async function insertProject(project_id: string): Promise<void> {
    await getPool().query("INSERT INTO projects (project_id) VALUES ($1)", [
      project_id,
    ]);
  }

  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  afterEach(async () => {
    await getPool().query("DELETE FROM project_storage_history_samples");
    await getPool().query("DELETE FROM projects");
  });

  afterAll(async () => {
    await testCleanup();
  });

  it("stores at most one sample per interval and loads history with growth", async () => {
    const project_id = uuid();
    await insertProject(project_id);
    const first = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const second = new Date(first.getTime() + 2 * 60 * 1000);
    const third = new Date(first.getTime() + 8 * 60 * 1000);

    await recordProjectStorageHistorySample({
      project_id,
      overview: {
        collected_at: first.toISOString(),
        quotas: [
          {
            key: "project",
            label: "Project quota",
            used: 100,
            size: 1000,
          },
        ],
        visible: [
          {
            key: "home",
            label: "/root",
            summaryLabel: "Home",
            path: "/root",
            summaryBytes: 80,
            usage: {
              path: "/root",
              bytes: 80,
              children: [],
              collected_at: first.toISOString(),
            },
          },
        ],
        counted: [],
      },
    });

    await recordProjectStorageHistorySample({
      project_id,
      overview: {
        collected_at: second.toISOString(),
        quotas: [
          {
            key: "project",
            label: "Project quota",
            used: 120,
            size: 1000,
          },
        ],
        visible: [
          {
            key: "home",
            label: "/root",
            summaryLabel: "Home",
            path: "/root",
            summaryBytes: 90,
            usage: {
              path: "/root",
              bytes: 90,
              children: [],
              collected_at: second.toISOString(),
            },
          },
        ],
        counted: [],
      },
    });

    await recordProjectStorageHistorySample({
      project_id,
      overview: {
        collected_at: third.toISOString(),
        quotas: [
          {
            key: "project",
            label: "Project quota",
            used: 220,
            size: 1000,
          },
        ],
        visible: [
          {
            key: "home",
            label: "/root",
            summaryLabel: "Home",
            path: "/root",
            summaryBytes: 180,
            usage: {
              path: "/root",
              bytes: 180,
              children: [],
              collected_at: third.toISOString(),
            },
          },
          {
            key: "scratch",
            label: "/scratch",
            summaryLabel: "Scratch",
            path: "/scratch",
            summaryBytes: 25,
            usage: {
              path: "/scratch",
              bytes: 25,
              children: [],
              collected_at: third.toISOString(),
            },
          },
        ],
        counted: [
          {
            key: "snapshots",
            label: "Snapshots",
            bytes: 44,
          },
        ],
      },
    });

    const history = await loadProjectStorageHistory({
      project_id,
      window_minutes: 24 * 60,
      max_points: 60,
    });

    expect(history.point_count).toBe(2);
    expect(history.points).toHaveLength(2);
    expect(history.points[0].quota_used_bytes).toBe(100);
    expect(history.points[1].quota_used_bytes).toBe(220);
    expect(history.points[1].home_visible_bytes).toBe(180);
    expect(history.points[1].scratch_visible_bytes).toBe(25);
    expect(history.points[1].snapshot_counted_bytes).toBe(44);
    expect(history.points[0].quota_used_percent).toBe(10);
    expect(history.points[1].quota_used_percent).toBe(22);
    expect(history.growth?.quota_used_bytes_per_hour).toBeCloseTo(900, 4);
  });

  it("clears project history", async () => {
    const project_id = uuid();
    await insertProject(project_id);
    await recordProjectStorageHistorySample({
      project_id,
      overview: {
        collected_at: new Date().toISOString(),
        quotas: [
          {
            key: "project",
            label: "Project quota",
            used: 55,
            size: 1000,
          },
        ],
        visible: [],
        counted: [],
      },
    });

    await clearProjectStorageHistory({ project_id });

    const history = await loadProjectStorageHistory({ project_id });
    expect(history.point_count).toBe(0);
    expect(history.points).toHaveLength(0);
    expect(history.growth).toBeUndefined();
  });

  it("allows forcing a sample inside the normal interval", async () => {
    const project_id = uuid();
    await insertProject(project_id);
    const first = new Date();
    const second = new Date(first.getTime() + 30 * 1000);

    await recordProjectStorageHistorySample({
      project_id,
      overview: {
        collected_at: first.toISOString(),
        quotas: [
          {
            key: "project",
            label: "Project quota",
            used: 12,
            size: 1000,
          },
        ],
        visible: [],
        counted: [],
      },
    });

    await recordProjectStorageHistorySample({
      project_id,
      force: true,
      overview: {
        collected_at: second.toISOString(),
        quotas: [
          {
            key: "project",
            label: "Project quota",
            used: 34,
            size: 1000,
          },
        ],
        visible: [],
        counted: [],
      },
    });

    const history = await loadProjectStorageHistory({
      project_id,
      window_minutes: 24 * 60,
      max_points: 60,
    });
    expect(history.point_count).toBe(2);
    expect(history.points).toHaveLength(2);
    expect(history.points[0].quota_used_bytes).toBe(12);
    expect(history.points[1].quota_used_bytes).toBe(34);
  });
});
