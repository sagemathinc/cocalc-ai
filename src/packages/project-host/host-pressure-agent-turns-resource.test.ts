/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Resource-count (inotify) pressure and emergency with running agent turns.
// William's last-resort exception is about memory ("if nothing else frees
// enough memory"); here a running turn keeps its idle protection, and a
// direct offender is stoppable whether or not it runs a turn ("Yes, an
// offender may still be stopped").

process.env.COCALC_PROJECT_HOST_RESOURCE_PRESSURE_MODE = "enforce";

import type { AgentTurnRead } from "./agent-turns";

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

// Required after the environment is set (the mode is read at import).
const { startHostPressureController } =
  require("./host-pressure") as typeof import("./host-pressure");
const { listProjectsByStates } =
  require("./sqlite/projects") as typeof import("./sqlite/projects");
const { getProjectStopState, listProjectStopPolicies } =
  require("./sqlite/stop-policy") as typeof import("./sqlite/stop-policy");

const now = Date.parse("2026-11-05T12:00:00Z");
const minute = 60_000;
const MAX_WATCHES = 2_097_152;

function turns(...ids: string[]): AgentTurnRead {
  return {
    ok: true,
    projects: new Map(ids.map((id) => [id, { started_at: now, leases: 1 }])),
    ended: new Set(),
    ended_cursor: now,
    invalid: 0,
  };
}

function projects(rows: [string, number][]) {
  jest
    .mocked(listProjectsByStates)
    .mockReturnValue(
      rows.map(([project_id]) => ({ project_id, state: "running" })) as any,
    );
  jest.mocked(listProjectStopPolicies).mockReturnValue(
    rows.map(([project_id, idleMinutes]) => ({
      project_id,
      owner_account_id: "owner",
      shared_compute_priority: 0,
      authoritative_last_edited_ms: now - idleMinutes * minute,
      policy_updated_ms: now,
      stop_override: "default",
    })) as any,
  );
}

// Host-wide inotify watches at `total`; the largest user is `offender`.
function metrics(total: number, offender: string): any {
  const largest = {
    project_id: offender,
    sampled_at_ms: now,
    age_ms: 0,
    pids: 2,
    threads: 4,
    file_descriptors: 100,
    sockets: 10,
    inotify_instances: 10,
    inotify_watches: 2_000_000,
  };
  return {
    memory_used_percent: 20,
    memory_available_bytes: 32 * 1024 ** 3,
    kernel_sysctls: {
      targets: {
        "fs.inotify.max_user_instances": 8192,
        "fs.inotify.max_user_watches": MAX_WATCHES,
      },
      values: {
        "fs.inotify.max_user_instances": 8192,
        "fs.inotify.max_user_watches": MAX_WATCHES,
      },
      ok: true,
      mismatches: [],
    },
    resource_pressure: {
      running_project_count: 3,
      sampled_project_count: 3,
      fresh_project_count: 3,
      stale_project_count: 0,
      missing_project_count: 0,
      truncated_project_count: 0,
      error_project_count: 0,
      total_pids: 6,
      total_threads: 12,
      total_file_descriptors: 300,
      total_sockets: 30,
      total_inotify_instances: 30,
      total_inotify_watches: total,
      largest_inotify_instances: largest,
      largest_inotify_watches: largest,
    },
  };
}

async function run(m: any, read: () => AgentTurnRead) {
  const stopProject = jest.fn(async (_opts: { project_id: string }) => {});
  const handle = startHostPressureController({
    refreshMetrics: async () => m,
    getCurrentMetrics: () => m,
    stopProject,
    readAgentTurns: read,
  });
  try {
    await jest.advanceTimersByTimeAsync(0);
    return {
      stopped: stopProject.mock.calls.map(([opts]) => opts.project_id),
      state: handle.getCurrentState(),
    };
  } finally {
    handle.stop();
  }
}

describe("resource-count pressure and running agent turns", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now });
    jest.clearAllMocks();
    jest.mocked(getProjectStopState).mockReturnValue(undefined);
    projects([
      ["offender-turn", 1],
      ["turn-idle", 600],
      ["plain-idle", 120],
    ]);
  });

  afterEach(() => jest.useRealTimers());

  it("a resource-only emergency stops the offender (turn or not) and others, never an idle turn project", async () => {
    const { stopped, state } = await run(
      metrics(Math.ceil(MAX_WATCHES * 0.97), "offender-turn"),
      () => turns("offender-turn", "turn-idle"),
    );
    expect(state).toMatchObject({ zone: "emergency" });
    expect(state?.reason).not.toContain("memory_");
    expect(stopped).toEqual(["offender-turn", "plain-idle"]);
  });

  it("a resource-only emergency with only idle turn projects left stops none of them (no memory last resort)", async () => {
    projects([["turn-idle", 600]]);
    const { stopped, state } = await run(
      metrics(Math.ceil(MAX_WATCHES * 0.97), "turn-idle-unrelated"),
      () => turns("turn-idle"),
    );
    expect(state).toMatchObject({ zone: "emergency" });
    expect(stopped).toEqual([]);
  });

  it("resource pressure with unreadable leases still stops the direct offender, and only it", async () => {
    const { stopped, state } = await run(
      metrics(Math.ceil(MAX_WATCHES * 0.88), "offender-turn"),
      () => ({ ok: false }),
    );
    expect(state).toMatchObject({
      zone: "pressure",
      agent_turns_unknown: true,
    });
    expect(stopped).toEqual(["offender-turn"]);
  });

  it("a resource-only emergency with unreadable leases stops only the offender", async () => {
    const { stopped, state } = await run(
      metrics(Math.ceil(MAX_WATCHES * 0.97), "offender-turn"),
      () => ({ ok: false }),
    );
    expect(state).toMatchObject({
      zone: "emergency",
      agent_turns_unknown: true,
    });
    expect(stopped).toEqual(["offender-turn"]);
  });
});
