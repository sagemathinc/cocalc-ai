/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let getManagedComponentStatusMock: jest.Mock;
let scheduleProjectHostRestartMock: jest.Mock;
let restartManagedLocalConatRouterMock: jest.Mock;
let restartManagedLocalConatPersistMock: jest.Mock;
let rolloutProjectHostAcpWorkerMock: jest.Mock;

jest.mock("./managed-components", () => ({
  __esModule: true,
  getManagedComponentStatus: (...args: any[]) =>
    getManagedComponentStatusMock(...args),
}));

jest.mock("./upgrade", () => ({
  __esModule: true,
  scheduleProjectHostRestart: (...args: any[]) =>
    scheduleProjectHostRestartMock(...args),
}));

jest.mock("./daemon", () => ({
  __esModule: true,
  restartManagedLocalConatRouter: (...args: any[]) =>
    restartManagedLocalConatRouterMock(...args),
  restartManagedLocalConatPersist: (...args: any[]) =>
    restartManagedLocalConatPersistMock(...args),
}));

jest.mock("./hub/acp/worker-manager", () => ({
  __esModule: true,
  rolloutProjectHostAcpWorker: (...args: any[]) =>
    rolloutProjectHostAcpWorkerMock(...args),
}));

function status(component: any, managed = true) {
  return {
    component,
    artifact: "project-host",
    upgrade_policy:
      component === "acp-worker" ? "drain_then_replace" : "restart_now",
    enabled: true,
    managed,
    desired_version: "v1",
    runtime_state: "running",
    version_state: "aligned",
    running_versions: ["v1"],
    running_pids: [1234],
  };
}

describe("rolloutManagedComponents", () => {
  beforeEach(() => {
    jest.resetModules();
    getManagedComponentStatusMock = jest.fn(() => [
      status("project-host"),
      status("conat-router"),
      status("conat-persist"),
      status("acp-worker"),
    ]);
    scheduleProjectHostRestartMock = jest.fn(async () => undefined);
    restartManagedLocalConatRouterMock = jest.fn(() => undefined);
    restartManagedLocalConatPersistMock = jest.fn(() => undefined);
    rolloutProjectHostAcpWorkerMock = jest.fn(async () => ({
      action: "drain_requested",
      message: "requested drain",
    }));
  });

  it("schedules project-host restart explicitly", async () => {
    const { rolloutManagedComponents } =
      await import("./managed-component-rollout");
    await expect(
      rolloutManagedComponents({ components: ["project-host"] }),
    ).resolves.toEqual({
      results: [
        {
          component: "project-host",
          action: "restart_scheduled",
          message: "scheduled project-host restart",
        },
      ],
    });
    expect(scheduleProjectHostRestartMock).toHaveBeenCalledTimes(1);
  });

  it("restarts managed local router and persist components", async () => {
    const { rolloutManagedComponents } =
      await import("./managed-component-rollout");
    await expect(
      rolloutManagedComponents({
        components: ["conat-router", "conat-persist"],
      }),
    ).resolves.toEqual({
      results: [
        {
          component: "conat-router",
          action: "restarted",
          message: "restarted managed local conat router",
        },
        {
          component: "conat-persist",
          action: "restarted",
          message: "restarted managed local conat persist",
        },
      ],
    });
    expect(restartManagedLocalConatRouterMock).toHaveBeenCalledTimes(1);
    expect(restartManagedLocalConatPersistMock).toHaveBeenCalledTimes(1);
  });

  it("returns noop when router is not independently managed", async () => {
    getManagedComponentStatusMock = jest.fn(() => [
      status("project-host"),
      status("conat-router", false),
      status("conat-persist"),
      status("acp-worker"),
    ]);
    const { rolloutManagedComponents } =
      await import("./managed-component-rollout");
    await expect(
      rolloutManagedComponents({ components: ["conat-router"] }),
    ).resolves.toEqual({
      results: [
        {
          component: "conat-router",
          action: "noop",
          message: "conat router is not running in managed local mode",
        },
      ],
    });
    expect(restartManagedLocalConatRouterMock).not.toHaveBeenCalled();
  });

  it("passes explicit reason through to ACP rollout", async () => {
    const { rolloutManagedComponents } =
      await import("./managed-component-rollout");
    await expect(
      rolloutManagedComponents({
        components: ["acp-worker"],
        reason: "bundle_upgrade",
      }),
    ).resolves.toEqual({
      results: [
        {
          component: "acp-worker",
          action: "drain_requested",
          message: "requested drain",
        },
      ],
    });
    expect(rolloutProjectHostAcpWorkerMock).toHaveBeenCalledWith({
      restartReason: "bundle_upgrade",
    });
  });
});
