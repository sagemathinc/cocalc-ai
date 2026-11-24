/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let callHubMock: jest.Mock;
let getMasterConatClientMock: jest.Mock;
let getLocalHostIdMock: jest.Mock;
let getProjectStopStateMock: jest.Mock;
let getProjectRuntimeMaintenanceStateMock: jest.Mock;
let getEffectivePressurePolicyMock: jest.Mock;

jest.mock("@cocalc/conat/hub/call-hub", () => ({
  __esModule: true,
  default: (...args: any[]) => callHubMock(...args),
}));

jest.mock("./master-status", () => ({
  __esModule: true,
  getMasterConatClient: (...args: any[]) => getMasterConatClientMock(...args),
}));

jest.mock("./sqlite/hosts", () => ({
  __esModule: true,
  getLocalHostId: (...args: any[]) => getLocalHostIdMock(...args),
}));

jest.mock("./sqlite/stop-policy", () => ({
  __esModule: true,
  getProjectStopState: (...args: any[]) => getProjectStopStateMock(...args),
}));

jest.mock("./runtime-maintenance", () => ({
  __esModule: true,
  getProjectRuntimeMaintenanceState: (...args: any[]) =>
    getProjectRuntimeMaintenanceStateMock(...args),
}));

jest.mock("./pressure-policy", () => ({
  __esModule: true,
  getEffectivePressurePolicy: (...args: any[]) =>
    getEffectivePressurePolicyMock(...args),
}));

describe("startProjectWithAdmission", () => {
  beforeEach(() => {
    jest.resetModules();
    callHubMock = jest.fn(async () => ({ ok: true }));
    getMasterConatClientMock = jest.fn(() => ({ id: "client-1" }));
    getLocalHostIdMock = jest.fn(() => "host-1");
    getProjectStopStateMock = jest.fn(() => undefined);
    getProjectRuntimeMaintenanceStateMock = jest.fn(() => undefined);
    // a shared-pool host unless a test says otherwise
    getEffectivePressurePolicyMock = jest.fn(() => ({
      watchOnly: false,
      tokens: [],
      refreshFailures: 0,
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("uses the host-authenticated project start RPC", async () => {
    const { startProjectWithAdmission } =
      await import("./project-start-admission");

    await expect(
      startProjectWithAdmission({
        account_id: "acct-1",
        project_id: "proj-1",
        autostart: true,
        wait: false,
        timeout: 12_345,
      }),
    ).resolves.toEqual({ ok: true });

    expect(callHubMock).toHaveBeenCalledWith({
      client: { id: "client-1" },
      host_id: "host-1",
      name: "projects.startFromHost",
      args: [
        {
          account_id: "acct-1",
          project_id: "proj-1",
          autostart: true,
          wait: false,
        },
      ],
      timeout: 12_345,
    });
    expect(getProjectStopStateMock).toHaveBeenCalledWith("proj-1");
  });

  it("blocks project starts during pressure cooldown", async () => {
    jest.spyOn(Date, "now").mockReturnValue(2_000_000);
    getProjectStopStateMock = jest.fn(() => ({
      project_id: "proj-1",
      pressure_cooldown_until_ms: 2_120_000,
      last_decision_reason: "direct:resource_project_inotify_watches",
    }));
    const { startProjectWithAdmission } =
      await import("./project-start-admission");

    await expect(
      startProjectWithAdmission({
        account_id: "acct-1",
        project_id: "proj-1",
      }),
    ).rejects.toThrow(
      "temporarily blocked because this project was recently stopped",
    );
    expect(callHubMock).not.toHaveBeenCalled();
  });

  it("blocks project starts during container runtime maintenance", async () => {
    getProjectRuntimeMaintenanceStateMock = jest.fn(() => ({
      reason: "container-runtime migration cni->netavark",
      started_at: "2026-07-14T21:00:00.000Z",
      expires_at: "2026-07-14T21:05:00.000Z",
      pid: 123,
    }));
    const { startProjectWithAdmission } =
      await import("./project-start-admission");

    await expect(
      startProjectWithAdmission({
        account_id: "acct-1",
        project_id: "proj-1",
      }),
    ).rejects.toThrow("container runtime");
    expect(callHubMock).not.toHaveBeenCalled();
  });

  it("blocks project starts during pressure quarantine", async () => {
    jest.spyOn(Date, "now").mockReturnValue(2_000_000);
    getProjectStopStateMock = jest.fn(() => ({
      project_id: "proj-1",
      pressure_cooldown_until_ms: 2_120_000,
      pressure_quarantine_until_ms: 88_400_000,
      pressure_quarantine_reason: "direct:resource_project_inotify_instances",
    }));
    const { startProjectWithAdmission } =
      await import("./project-start-admission");

    await expect(
      startProjectWithAdmission({
        account_id: "acct-1",
        project_id: "proj-1",
      }),
    ).rejects.toThrow("repeatedly exceeded project-host resource limits");
    expect(callHubMock).not.toHaveBeenCalled();
  });

  it("allows project starts after pressure cooldown expires", async () => {
    jest.spyOn(Date, "now").mockReturnValue(2_000_000);
    getProjectStopStateMock = jest.fn(() => ({
      project_id: "proj-1",
      pressure_cooldown_until_ms: 1_999_999,
    }));
    const { startProjectWithAdmission } =
      await import("./project-start-admission");

    await expect(
      startProjectWithAdmission({
        account_id: "acct-1",
        project_id: "proj-1",
      }),
    ).resolves.toEqual({ ok: true });
    expect(callHubMock).toHaveBeenCalledTimes(1);
  });

  describe("on a watch-only host", () => {
    const blockedState = () => ({
      project_id: "proj-1",
      pressure_cooldown_until_ms: 3_000_000,
      pressure_quarantine_until_ms: 3_000_000,
      pressure_quarantine_reason: "memory",
    });

    it("a private host starts a project despite an earlier cooldown and quarantine", async () => {
      jest.spyOn(Date, "now").mockReturnValue(2_000_000);
      getEffectivePressurePolicyMock = jest.fn(() => ({
        watchOnly: true,
        tokens: ["watch_only_private_host"],
        refreshFailures: 0,
      }));
      getProjectStopStateMock = jest.fn(blockedState);
      const { startProjectWithAdmission } =
        await import("./project-start-admission");
      await expect(
        startProjectWithAdmission({ account_id: "acct-1", project_id: "proj-1" }),
      ).resolves.toEqual({ ok: true });
      expect(callHubMock).toHaveBeenCalledTimes(1);
    });

    it("a host the bay has not answered for yet does not block either", async () => {
      jest.spyOn(Date, "now").mockReturnValue(2_000_000);
      getEffectivePressurePolicyMock = jest.fn(() => ({
        watchOnly: true,
        tokens: ["policy_unknown"],
        refreshFailures: 0,
      }));
      getProjectStopStateMock = jest.fn(blockedState);
      const { startProjectWithAdmission } =
        await import("./project-start-admission");
      await expect(
        startProjectWithAdmission({ account_id: "acct-1", project_id: "proj-1" }),
      ).resolves.toEqual({ ok: true });
    });

    it("a private host still pauses starts during container runtime maintenance", async () => {
      getEffectivePressurePolicyMock = jest.fn(() => ({
        watchOnly: true,
        tokens: ["watch_only_private_host"],
        refreshFailures: 0,
      }));
      getProjectRuntimeMaintenanceStateMock = jest.fn(() => ({
        operation_id: "op-1",
      }));
      const { startProjectWithAdmission } =
        await import("./project-start-admission");
      await expect(
        startProjectWithAdmission({ account_id: "acct-1", project_id: "proj-1" }),
      ).rejects.toThrow("container runtime");
      expect(callHubMock).not.toHaveBeenCalled();
    });

    it("a shared host with a stale policy still blocks on the same state", async () => {
      jest.spyOn(Date, "now").mockReturnValue(2_000_000);
      getEffectivePressurePolicyMock = jest.fn(() => ({
        watchOnly: false,
        tokens: ["policy_stale"],
        refreshFailures: 3,
      }));
      getProjectStopStateMock = jest.fn(blockedState);
      const { startProjectWithAdmission } =
        await import("./project-start-admission");
      await expect(
        startProjectWithAdmission({ account_id: "acct-1", project_id: "proj-1" }),
      ).rejects.toThrow("repeatedly exceeded project-host resource limits");
      expect(callHubMock).not.toHaveBeenCalled();
    });
  });

  it("requires a local host id", async () => {
    getLocalHostIdMock = jest.fn(() => undefined);
    const { startProjectWithAdmission } =
      await import("./project-start-admission");

    await expect(
      startProjectWithAdmission({
        account_id: "acct-1",
        project_id: "proj-1",
      }),
    ).rejects.toThrow("host id is required to start a project");
  });
});
