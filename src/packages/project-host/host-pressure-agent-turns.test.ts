/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Projects with a running agent turn under host pressure. William:
// - 2026-11-04: "never stop a project with an agent turn running";
// - 2026-11-05, emergency: "Protect it in emergency too, but allow a
//   last-resort stop if nothing else frees enough memory"; offenders in an
//   emergency: "Yes, same answer for offenders"; offenders in the pressure
//   zone: "Yes, an offender may still be stopped"; "No time limit".

import type { HostCurrentMetrics } from "@cocalc/conat/hub/api/hosts";
import type { AgentTurnRead } from "./agent-turns";
import { _test, startHostPressureController } from "./host-pressure";
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

const now = Date.parse("2026-11-05T12:00:00Z");
const minute = 60_000;

function turns(...ids: string[]): AgentTurnRead {
  return {
    ok: true,
    projects: new Map(ids.map((id) => [id, { started_at: now, leases: 1 }])),
    ended: new Set(),
    ended_cursor: now,
    invalid: 0,
  };
}

// [project_id, shared_compute_priority, idle minutes]
function projects(rows: [string, number, number][]) {
  jest
    .mocked(listProjectsByStates)
    .mockReturnValue(
      rows.map(([project_id]) => ({ project_id, state: "running" })) as any,
    );
  jest.mocked(listProjectStopPolicies).mockReturnValue(
    rows.map(([project_id, shared_compute_priority, idleMinutes]) => ({
      project_id,
      owner_account_id: "owner",
      shared_compute_priority,
      authoritative_last_edited_ms: now - idleMinutes * minute,
      policy_updated_ms: now,
      stop_override: "default",
    })) as any,
  );
}

function controller(
  metrics: () => HostCurrentMetrics,
  readAgentTurns: () => AgentTurnRead,
) {
  const stopProject = jest.fn(async (_opts: { project_id: string }) => {});
  const handle = startHostPressureController({
    refreshMetrics: async () => metrics(),
    getCurrentMetrics: () => metrics(),
    stopProject,
    readAgentTurns,
  });
  const stopped = () => stopProject.mock.calls.map(([opts]) => opts.project_id);
  return { handle, stopProject, stopped };
}

describe("host pressure and running agent turns", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now });
    jest.clearAllMocks();
    jest.mocked(getProjectStopState).mockReturnValue(undefined);
  });

  afterEach(() => jest.useRealTimers());

  it("pressure zone: an idle-looking project with a running turn is not stopped; others are", async () => {
    projects([
      ["turn-idle", 0, 600],
      ["plain-idle", 0, 120],
    ]);
    const read = jest.fn(() => turns("turn-idle"));
    const c = controller(() => ({ memory_used_percent: 81 }), read);
    try {
      await jest.advanceTimersByTimeAsync(0);
      expect(c.stopped()).toEqual(["plain-idle"]);
      expect(c.handle.getCurrentState()).toMatchObject({
        zone: "pressure",
        agent_turn_protected_count: 1,
      });
      // One read per evaluation.
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      c.handle.stop();
    }
  });

  it("pressure zone: an unreadable lease set stops nothing", async () => {
    projects([["plain-idle", 0, 120]]);
    const c = controller(
      () => ({ memory_used_percent: 81 }),
      () => ({ ok: false }),
    );
    try {
      await jest.advanceTimersByTimeAsync(0);
      expect(c.stopped()).toEqual([]);
      expect(c.handle.getCurrentState()).toMatchObject({
        zone: "pressure",
        agent_turns_unknown: true,
      });
    } finally {
      c.handle.stop();
    }
  });

  it("emergency: an unreadable lease set still lets the emergency act", async () => {
    projects([["turn-idle", 0, 600]]);
    const c = controller(
      () => ({ memory_used_percent: 91 }),
      () => ({ ok: false }),
    );
    try {
      await jest.advanceTimersByTimeAsync(0);
      expect(c.stopped()).toEqual(["turn-idle"]);
      expect(c.handle.getCurrentState()).toMatchObject({
        zone: "emergency",
        agent_turns_unknown: true,
      });
    } finally {
      c.handle.stop();
    }
  });

  it("emergency: turn projects are never in the same batch as other candidates", async () => {
    projects([
      ["turn-a", 0, 600],
      ["turn-b", 0, 600],
      ["plain", 0, 1],
    ]);
    const c = controller(
      () => ({ memory_used_percent: 91 }),
      () => turns("turn-a", "turn-b"),
    );
    try {
      await jest.advanceTimersByTimeAsync(0);
      // Only the other candidate, although the per-cycle cap allows more.
      expect(c.stopped()).toEqual(["plain"]);
    } finally {
      c.handle.stop();
    }
  });

  it("emergency: with only turn projects left, exactly one is stopped as a last resort", async () => {
    projects([
      ["turn-a", 0, 600],
      ["turn-b", 0, 300],
    ]);
    const c = controller(
      () => ({ memory_used_percent: 91 }),
      () => turns("turn-a", "turn-b"),
    );
    try {
      await jest.advanceTimersByTimeAsync(0);
      expect(c.stopped()).toEqual(["turn-a"]);
    } finally {
      c.handle.stop();
    }
  });

  it("(d) emergency: once other stops bring the host below emergency, no turn project is stopped", async () => {
    projects([
      ["turn-a", 0, 600],
      ["plain", 0, 1],
    ]);
    let used = 91;
    const c = controller(
      () => ({ memory_used_percent: used }),
      () => turns("turn-a"),
    );
    try {
      await jest.advanceTimersByTimeAsync(0);
      expect(c.stopped()).toEqual(["plain"]);
      // The stop freed enough memory: the next, fresh measurement is below
      // emergency (still memory pressure), and turn-a stays.
      projects([["turn-a", 0, 600]]);
      used = 85;
      await jest.advanceTimersByTimeAsync(30_000);
      expect(c.stopped()).toEqual(["plain"]);
      expect(c.handle.getCurrentState()).toMatchObject({
        zone: "pressure",
        agent_turn_protected_count: 1,
      });
      // Had it stayed an emergency, turn-a would be the last resort (one
      // evaluation; the mocked project never actually stops).
      used = 91;
      await jest.advanceTimersByTimeAsync(10_000);
      expect(c.stopped()).toEqual(["plain", "turn-a"]);
    } finally {
      c.handle.stop();
    }
  });

  it("a running turn protects however long it has run (no age limit)", async () => {
    projects([["turn-old", 0, 24 * 60]]);
    const old: AgentTurnRead = {
      ...(turns() as any),
      projects: new Map([
        ["turn-old", { started_at: now - 24 * 60 * minute, leases: 1 }],
      ]),
    };
    const c = controller(
      () => ({ memory_used_percent: 81 }),
      () => old,
    );
    try {
      await jest.advanceTimersByTimeAsync(0);
      expect(c.stopped()).toEqual([]);
    } finally {
      c.handle.stop();
    }
  });
});

describe("buildStopCandidates with running agent turns", () => {
  const policy = (project_id: string, idleMinutes: number) => [
    project_id,
    {
      project_id,
      owner_account_id: "owner",
      shared_compute_priority: 0,
      authoritative_last_edited_ms: now - idleMinutes * minute,
      policy_updated_ms: now,
      stop_override: "default",
    } as any,
  ];
  const base = {
    projects: [
      { project_id: "turn-offender", state: "running" },
      { project_id: "turn-idle", state: "running" },
      { project_id: "plain-idle", state: "running" },
    ] as any,
    policies: new Map([
      policy("turn-offender", 1),
      policy("turn-idle", 600),
      policy("plain-idle", 120),
    ] as any),
    getStopState: () => undefined,
    now,
    directResourceOffenders: new Map([
      [
        "turn-offender",
        {
          project_id: "turn-offender",
          reason: "resource_project_inotify_watches>=1",
          score: 10,
          zone: "pressure",
        },
      ],
    ] as any),
    agentTurnProjects: new Set(["turn-offender", "turn-idle"]),
  };

  it("pressure zone: a direct offender with a running turn stays a candidate at its rank; idle turn projects are left out", () => {
    const stats = { agent_turn_protected: 0 };
    const candidates = _test.buildStopCandidates({
      ...base,
      zone: "pressure",
      minimumIdleMs: 60 * minute,
      stats,
    });
    expect(candidates.map((c) => c.project_id)).toEqual([
      "turn-offender",
      "plain-idle",
    ]);
    expect(stats.agent_turn_protected).toBe(1);
  });

  it("emergency: turn projects, offenders included, sort after every other candidate", () => {
    const candidates = _test.buildStopCandidates({
      ...base,
      zone: "emergency",
    });
    expect(candidates.map((c) => [c.project_id, c.agent_turn])).toEqual([
      ["plain-idle", false],
      ["turn-offender", true],
      ["turn-idle", true],
    ]);
    expect(candidates[1].explanation).toContain("agent_turn");
  });

  it("without agent turn data, today's order is unchanged", () => {
    const candidates = _test.buildStopCandidates({
      ...base,
      agentTurnProjects: undefined,
      zone: "emergency",
    });
    expect(candidates.map((c) => c.project_id)).toEqual([
      "turn-offender",
      "turn-idle",
      "plain-idle",
    ]);
  });
});
