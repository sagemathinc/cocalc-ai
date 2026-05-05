/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const inspectProjectHostRuntimeMock = jest.fn();
const restartProjectHostMock = jest.fn();
const activateInstalledProjectHostVersionMock = jest.fn();

jest.mock("./daemon", () => ({
  __esModule: true,
  ensureDaemon: jest.fn(),
  inspectProjectHostRuntime: (...args: any[]) =>
    inspectProjectHostRuntimeMock(...args),
  restartProjectHost: (...args: any[]) => restartProjectHostMock(...args),
}));

jest.mock("./upgrade", () => ({
  __esModule: true,
  activateInstalledProjectHostVersion: (...args: any[]) =>
    activateInstalledProjectHostVersionMock(...args),
}));

describe("project-host host-agent local rollback", () => {
  let reconcileProjectHostRollback: any;

  beforeEach(async () => {
    jest.resetModules();
    inspectProjectHostRuntimeMock.mockReset();
    restartProjectHostMock.mockReset();
    activateInstalledProjectHostVersionMock.mockReset();
    ({
      __test__: { reconcileProjectHostRollback },
    } = await import("./host-agent"));
  });

  function mkdtemp(prefix: string) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  }

  function statePath(dataDir: string) {
    return path.join(dataDir, "host-agent-state.json");
  }

  it("restarts a healthy old project-host onto the rollout candidate and starts rollback tracking", async () => {
    const dataDir = mkdtemp("cocalc-host-agent-");
    fs.writeFileSync(
      statePath(dataDir),
      JSON.stringify({
        project_host: {
          last_known_good_version: "ph-v1",
        },
      }),
    );
    inspectProjectHostRuntimeMock.mockReturnValue({
      dataDir,
      currentVersion: "ph-v2",
      runningPid: 1234,
      runningVersion: "ph-v1",
      healthy: true,
    });

    await reconcileProjectHostRollback({
      index: 0,
      timeoutMs: 60_000,
    });

    const state = JSON.parse(fs.readFileSync(statePath(dataDir), "utf8"));
    expect(state.project_host.last_known_good_version).toBe("ph-v1");
    expect(state.project_host.pending_rollout).toMatchObject({
      target_version: "ph-v2",
      previous_version: "ph-v1",
    });
    expect(state.project_host.rollout).toMatchObject({
      phase: "restart_requested",
      target_version: "ph-v2",
      previous_version: "ph-v1",
      running_version: "ph-v1",
      healthy: true,
    });
    expect(activateInstalledProjectHostVersionMock).not.toHaveBeenCalled();
    expect(restartProjectHostMock).toHaveBeenCalledWith(0, {
      preserveManagedAuxiliaryDaemons: true,
    });
  });

  it("promotes a healthy candidate project-host bundle to last-known-good", async () => {
    const dataDir = mkdtemp("cocalc-host-agent-");
    fs.writeFileSync(
      statePath(dataDir),
      JSON.stringify({
        project_host: {
          last_known_good_version: "ph-v1",
          pending_rollout: {
            target_version: "ph-v2",
            previous_version: "ph-v1",
            started_at: "2026-04-15T00:00:00.000Z",
            deadline_at: "2026-04-15T00:02:00.000Z",
          },
        },
      }),
    );
    inspectProjectHostRuntimeMock.mockReturnValue({
      dataDir,
      currentVersion: "ph-v2",
      runningPid: 4321,
      runningVersion: "ph-v2",
      healthy: true,
    });

    await reconcileProjectHostRollback({
      index: 0,
      timeoutMs: 60_000,
    });

    const state = JSON.parse(fs.readFileSync(statePath(dataDir), "utf8"));
    expect(state.project_host.last_known_good_version).toBe("ph-v2");
    expect(state.project_host.pending_rollout).toBeUndefined();
    expect(state.project_host.rollout).toMatchObject({
      phase: "promoted",
      target_version: "ph-v2",
      previous_version: "ph-v1",
      running_version: "ph-v2",
      healthy: true,
    });
    expect(state.project_host.rollout.accepted_at).toEqual(expect.any(String));
  });

  it("rolls back to the previous version when the candidate misses its health deadline", async () => {
    const dataDir = mkdtemp("cocalc-host-agent-");
    fs.writeFileSync(
      statePath(dataDir),
      JSON.stringify({
        project_host: {
          last_known_good_version: "ph-v1",
          pending_rollout: {
            target_version: "ph-v2",
            previous_version: "ph-v1",
            started_at: "2026-04-15T00:00:00.000Z",
            deadline_at: "2026-04-15T00:00:01.000Z",
          },
        },
      }),
    );
    inspectProjectHostRuntimeMock.mockReturnValue({
      dataDir,
      currentVersion: "ph-v2",
      runningPid: undefined,
      runningVersion: undefined,
      healthy: false,
    });

    await reconcileProjectHostRollback({
      index: 0,
      timeoutMs: 60_000,
    });

    expect(activateInstalledProjectHostVersionMock).toHaveBeenCalledWith(
      "ph-v1",
    );
    expect(restartProjectHostMock).toHaveBeenCalledWith(0, {
      preserveManagedAuxiliaryDaemons: true,
    });
    const state = JSON.parse(fs.readFileSync(statePath(dataDir), "utf8"));
    expect(state.project_host.last_known_good_version).toBe("ph-v1");
    expect(state.project_host.pending_rollout).toBeUndefined();
    expect(state.project_host.rollout).toMatchObject({
      phase: "rollback_requested",
      target_version: "ph-v2",
      previous_version: "ph-v1",
      healthy: false,
      failure_reason: "health_deadline_exceeded",
    });
    expect(state.project_host.last_automatic_rollback).toMatchObject({
      target_version: "ph-v2",
      rollback_version: "ph-v1",
      reason: "health_deadline_exceeded",
    });
  });

  it("normalizes a requested rollback into a rolled-back terminal rollout record on the next healthy pass", async () => {
    const dataDir = mkdtemp("cocalc-host-agent-");
    fs.writeFileSync(
      statePath(dataDir),
      JSON.stringify({
        project_host: {
          last_known_good_version: "ph-v1",
          rollout: {
            phase: "rollback_requested",
            target_version: "ph-v2",
            previous_version: "ph-v1",
            started_at: "2026-04-15T00:00:00.000Z",
            deadline_at: "2026-04-15T00:00:01.000Z",
            rollback_started_at: "2026-04-15T00:00:02.000Z",
            failure_reason: "health_deadline_exceeded",
          },
          last_automatic_rollback: {
            target_version: "ph-v2",
            rollback_version: "ph-v1",
            started_at: "2026-04-15T00:00:00.000Z",
            finished_at: "2026-04-15T00:00:03.000Z",
            reason: "health_deadline_exceeded",
          },
        },
      }),
    );
    inspectProjectHostRuntimeMock.mockReturnValue({
      dataDir,
      currentVersion: "ph-v1",
      runningPid: 2222,
      runningVersion: "ph-v1",
      healthy: true,
    });

    await reconcileProjectHostRollback({
      index: 0,
      timeoutMs: 60_000,
    });

    const state = JSON.parse(fs.readFileSync(statePath(dataDir), "utf8"));
    expect(state.project_host.rollout).toMatchObject({
      phase: "rolled_back",
      target_version: "ph-v2",
      previous_version: "ph-v1",
      running_version: "ph-v1",
      healthy: true,
      rollback_started_at: "2026-04-15T00:00:02.000Z",
      rollback_finished_at: "2026-04-15T00:00:03.000Z",
      failure_reason: "health_deadline_exceeded",
    });
  });
});
