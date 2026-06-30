/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let callHubMock: jest.Mock;
let getMasterConatClientMock: jest.Mock;
let getLocalHostIdMock: jest.Mock;
let getProjectStopStateMock: jest.Mock;

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

describe("startProjectWithAdmission", () => {
  beforeEach(() => {
    jest.resetModules();
    callHubMock = jest.fn(async () => ({ ok: true }));
    getMasterConatClientMock = jest.fn(() => ({ id: "client-1" }));
    getLocalHostIdMock = jest.fn(() => "host-1");
    getProjectStopStateMock = jest.fn(() => undefined);
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
