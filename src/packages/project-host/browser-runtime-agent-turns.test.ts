/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Browser-idle stops never stop a project with a running agent turn
// (William, 2026-11-04), and stop nothing when the turns can't be read.

import type { AgentTurnRead } from "./agent-turns";
import { startBrowserIdleStopMaintenance } from "./browser-runtime";
import { listProjectsByStates } from "./sqlite/projects";
import { getProjectStopState } from "./sqlite/stop-policy";

jest.mock("./sqlite/projects", () => ({ listProjectsByStates: jest.fn() }));
jest.mock("./sqlite/stop-policy", () => ({
  getProjectStopState: jest.fn(),
  noteProjectBrowserActivity: jest.fn(),
}));

const now = Date.parse("2026-11-05T12:00:00Z");
const minute = 60_000;

function idleProjects(...ids: string[]) {
  jest.mocked(listProjectsByStates).mockReturnValue(
    ids.map((project_id) => ({
      project_id,
      state: "running",
      // 30 min timeout, last activity 2 h ago: past the deadline.
      run_quota: { browser_idle_timeout: 1800 },
      state_updated_at: now - 120 * minute,
    })) as any,
  );
}

function turns(...ids: string[]): AgentTurnRead {
  return {
    ok: true,
    projects: new Map(ids.map((id) => [id, { started_at: now, leases: 1 }])),
    ended: new Set(),
    ended_cursor: now,
    invalid: 0,
  };
}

async function sweep(readAgentTurns?: () => AgentTurnRead) {
  const stopProject = jest.fn(async (_project_id: string) => {});
  const stop = startBrowserIdleStopMaintenance({
    stopProject,
    interval_ms: 60 * minute,
    now: () => now,
    readAgentTurns,
  });
  await jest.advanceTimersByTimeAsync(0);
  stop();
  return stopProject.mock.calls.map(([project_id]) => project_id).sort();
}

describe("browser-idle maintenance and running agent turns", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now });
    jest.clearAllMocks();
    jest.mocked(getProjectStopState).mockReturnValue(undefined);
  });

  afterEach(() => jest.useRealTimers());

  it("a project with a running turn is not stopped at its deadline; others are", async () => {
    idleProjects("turn", "plain");
    expect(await sweep(() => turns("turn"))).toEqual(["plain"]);
  });

  it("without a running turn (it ended or went stale), the project is stopped", async () => {
    idleProjects("turn", "plain");
    expect(await sweep(() => turns())).toEqual(["plain", "turn"]);
  });

  it("an unreadable lease set stops nothing that sweep", async () => {
    idleProjects("turn", "plain");
    expect(await sweep(() => ({ ok: false }))).toEqual([]);
  });

  it("the leases are not read when nothing is due", async () => {
    jest.mocked(listProjectsByStates).mockReturnValue([]);
    const read = jest.fn(() => turns());
    expect(await sweep(read)).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it("without a reader, today's behaviour is unchanged", async () => {
    idleProjects("turn", "plain");
    expect(await sweep()).toEqual(["plain", "turn"]);
  });
});
