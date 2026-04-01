import assert from "node:assert/strict";
import test from "node:test";

import { testOnly } from "./storage";

test("buildStorageAnalysis recommends deleting snapshots and reviewing environment changes", () => {
  const analysis = testOnly.buildStorageAnalysis({
    project_id: "project-id",
    title: "Project",
    homePath: "/root",
    overview: {
      collected_at: "2026-04-01T10:00:00.000Z",
      quotas: [
        {
          key: "project",
          label: "Project quota",
          used: 18 * 1024 ** 3,
          size: 20 * 1024 ** 3,
        },
      ],
      visible: [
        {
          key: "home",
          label: "/root",
          summaryLabel: "Home",
          path: "/root",
          summaryBytes: 600 * 1024 ** 2,
          usage: {
            path: "/root",
            bytes: 8 * 1024 ** 3,
            children: [],
            collected_at: "2026-04-01T10:00:00.000Z",
          },
        },
        {
          key: "environment",
          label: "Environment changes",
          summaryLabel: "Environment",
          path: "/root/.local/share/cocalc/rootfs",
          summaryBytes: 7 * 1024 ** 3,
          usage: {
            path: "/root/.local/share/cocalc/rootfs",
            bytes: 7 * 1024 ** 3,
            children: [],
            collected_at: "2026-04-01T10:00:00.000Z",
          },
        },
      ],
      counted: [
        {
          key: "snapshots",
          label: "Snapshots",
          bytes: 3 * 1024 ** 3,
          detail: "snapshot detail",
        },
      ],
    },
    history: {
      window_minutes: 24 * 60,
      point_count: 2,
      points: [
        {
          collected_at: "2026-04-01T09:00:00.000Z",
          quota_used_bytes: 17 * 1024 ** 3,
        },
        {
          collected_at: "2026-04-01T10:00:00.000Z",
          quota_used_bytes: 18 * 1024 ** 3,
        },
      ],
      growth: {
        window_minutes: 24 * 60,
        quota_used_bytes_per_hour: 1024 ** 3,
      },
    },
    breakdowns: [
      {
        key: "home",
        label: "Home",
        path: "/root",
        bytes: 600 * 1024 ** 2,
        children: [
          {
            path: ".cache",
            absolute_path: "/root/.cache",
            bytes: 300 * 1024 ** 2,
            percent: 50,
          },
        ],
      },
      {
        key: "environment",
        label: "Environment",
        path: "/root/.local/share/cocalc/rootfs",
        bytes: 7 * 1024 ** 3,
      },
    ],
  });

  assert.equal(analysis.summary.counted.snapshots?.bytes, 3 * 1024 ** 3);
  assert.ok(
    analysis.findings.some((finding) => finding.id === "snapshots_present"),
  );
  assert.ok(
    analysis.findings.some(
      (finding) => finding.id === "environment_dominates_home",
    ),
  );
  assert.equal(analysis.recommendations[0]?.id, "delete_snapshots");
  assert.ok(
    analysis.recommendations.some((recommendation) =>
      recommendation.actions.some(
        (action) => action.path === "/root/.snapshots",
      ),
    ),
  );
});

test("parseHistoryWindowMinutes converts duration strings into bounded minutes", () => {
  assert.equal(
    testOnly.parseHistoryWindowMinutes((value: string) => {
      assert.equal(value, "7d");
      return 7 * 24 * 60 * 60 * 1000;
    }, "7d"),
    7 * 24 * 60,
  );
});

test("flattenBreakdownRows sorts children and computes percentages", () => {
  const rows = testOnly.flattenBreakdownRows({
    path: "/root",
    bytes: 100,
    children: [
      { path: "b", bytes: 10 },
      { path: "a", bytes: 90 },
    ],
    collected_at: "2026-04-01T10:00:00.000Z",
  });

  assert.deepEqual(rows, [
    { path: "/root/a", bytes: "90 bytes", percent: "90%" },
    { path: "/root/b", bytes: "10 bytes", percent: "10%" },
  ]);
});
