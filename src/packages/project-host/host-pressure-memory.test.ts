/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { HostCurrentMetrics } from "@cocalc/conat/hub/api/hosts";
import { startHostPressureController } from "./host-pressure";
import { listProjectsByStates } from "./sqlite/projects";
import {
  getProjectStopState,
  listProjectStopPolicies,
} from "./sqlite/stop-policy";

jest.mock("./sqlite/projects", () => ({ listProjectsByStates: jest.fn() }));
jest.mock("./sqlite/stop-policy", () => ({
  getProjectStopState: jest.fn(),
  listProjectStopPolicies: jest.fn(),
  upsertProjectStopState: jest.fn(),
}));
jest.mock("./project-workload-activity", () => ({
  ...jest.requireActual("./project-workload-activity"),
  sampleProjectWorkloads: jest.fn(async () => []),
}));

const now = Date.parse("2026-09-27T12:00:00Z");
const minute = 60_000;

describe("memory pressure eviction", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now });
    jest.clearAllMocks();
    jest.mocked(getProjectStopState).mockReturnValue(undefined);
  });

  afterEach(() => jest.useRealTimers());

  function projects(rows: [string, number, number | null][]) {
    jest
      .mocked(listProjectsByStates)
      .mockReturnValue(
        rows.map(([project_id]) => ({ project_id, state: "running" })),
      );
    jest.mocked(listProjectStopPolicies).mockReturnValue(
      rows
        .filter(([project_id]) => project_id !== "missing-policy")
        .map(([project_id, shared_compute_priority, idleMinutes]) => ({
          project_id,
          owner_account_id: "owner",
          shared_compute_priority,
          authoritative_last_edited_ms:
            idleMinutes == null ? null : now - idleMinutes * minute,
          policy_updated_ms: now,
          stop_override: "default",
        })),
    );
  }

  async function run(metrics: HostCurrentMetrics) {
    const stopProject = jest.fn(async (_opts: { project_id: string }) => {});
    const reportPressureAction = jest.fn(async () => {});
    const controller = startHostPressureController({
      refreshMetrics: async () => metrics,
      getCurrentMetrics: () => metrics,
      stopProject,
      reportPressureAction,
    });
    try {
      await jest.advanceTimersByTimeAsync(0);
      return {
        stopProject,
        reportPressureAction,
        state: controller.getCurrentState(),
      };
    } finally {
      controller.stop();
    }
  }

  it("protects recent and unknown activity, with an inclusive idle boundary", async () => {
    projects([
      ["active-free", 0, 1],
      ["just-too-recent", 0, 59.99],
      ["boundary", 0, 60],
      ["idle-paid", 5, 120],
      ["missing-policy", 0, null],
      ["missing-edit", 0, null],
      ["future-edit", 0, -1],
      ["zero-edit", 0, now / minute],
      ["invalid-edit", 0, NaN],
      ["infinite-edit", 0, Infinity],
    ]);
    const { stopProject, reportPressureAction, state } = await run({
      memory_used_percent: 81,
    });
    expect(stopProject.mock.calls.map(([opts]) => opts.project_id)).toEqual([
      "idle-paid",
      "boundary",
    ]);
    expect(state).toMatchObject({ zone: "pressure", candidate_count: 2 });
    expect(reportPressureAction).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "idle-paid",
        reason: expect.stringContaining("idle_ms:7200000"),
      }),
    );
  });

  it("does not stop active projects when no idle candidates remain", async () => {
    projects([
      ["active-free", 0, 1],
      ["active-paid", 5, 2],
    ]);
    const { stopProject, state } = await run({ memory_used_percent: 81 });
    expect(stopProject).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      zone: "pressure",
      candidate_count: 0,
      last_action_status: "no_candidates",
    });
  });

  it.each([
    { memory_used_percent: 91 },
    {
      memory_total_bytes: 8 * 1024 ** 3,
      memory_available_bytes: 0.5 * 1024 ** 3,
    },
  ])(
    "keeps recently active projects evictable in a memory emergency: %j",
    async (metrics) => {
      projects([
        ["active-free", 0, 1],
        ["idle-paid", 5, 60],
      ]);
      jest.mocked(getProjectStopState).mockImplementation((project_id) =>
        project_id === "active-free"
          ? {
              project_id,
              last_started_ms: now - minute,
              pressure_cooldown_until_ms: now + minute,
            }
          : undefined,
      );
      const { stopProject, state } = await run(metrics);
      expect(stopProject.mock.calls.map(([opts]) => opts.project_id)).toEqual([
        "idle-paid",
        "active-free",
      ]);
      expect(state).toMatchObject({ zone: "emergency", candidate_count: 2 });
    },
  );

  it("keeps unknown activity as emergency fallback without inventing priority zero", async () => {
    projects([
      ["missing-policy", 0, null],
      ["missing-edit", 5, null],
      ["idle-paid", 5, 120],
      ["active-free", 0, 1],
    ]);
    const { stopProject } = await run({ memory_used_percent: 91 });
    expect(stopProject.mock.calls.map(([opts]) => opts.project_id)).toEqual([
      "idle-paid",
      "active-free",
      "missing-edit",
      "missing-policy",
    ]);
    expect(stopProject).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "missing-policy",
        shared_compute_priority: undefined,
        reason: expect.stringContaining("priority:unknown"),
      }),
    );
  });

  it("does not infer tier or inactivity from absent browser presence", async () => {
    projects([
      ["older-paid", 5, 120],
      ["newer-free", 0, 90],
      ["active-paid", 5, 30],
    ]);
    jest
      .mocked(getProjectStopState)
      .mockImplementation((project_id) =>
        project_id === "newer-free"
          ? { project_id, last_browser_activity_ms: now }
          : undefined,
      );
    const { stopProject } = await run({ memory_used_percent: 81 });
    expect(stopProject.mock.calls.map(([opts]) => opts.project_id)).toEqual([
      "older-paid",
      "newer-free",
    ]);
    expect(stopProject).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "older-paid",
        shared_compute_priority: 5,
        reason: expect.stringContaining("browser_presence_age_ms:unknown"),
      }),
    );
  });

  it("uses unknown priority only as a conservative tie breaker, not priority zero", async () => {
    projects([
      ["unknown-tier", NaN, 120],
      ["paid", 5, 120],
      ["newer-free", 0, 90],
    ]);
    const { stopProject } = await run({ memory_used_percent: 81 });
    expect(stopProject.mock.calls.map(([opts]) => opts.project_id)).toEqual([
      "paid",
      "unknown-tier",
      "newer-free",
    ]);
    expect(stopProject).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "unknown-tier",
        shared_compute_priority: undefined,
        reason: expect.stringContaining("priority:unknown"),
      }),
    );
  });
});
