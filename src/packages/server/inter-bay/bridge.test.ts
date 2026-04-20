/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

const requestMock = jest.fn();

jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  __esModule: true,
  getInterBayFabricClient: jest.fn(() => ({
    request: (...args: any[]) => requestMock(...args),
  })),
}));

describe("inter-bay bridge", () => {
  beforeEach(() => {
    jest.resetModules();
    requestMock.mockReset();
    delete process.env.COCALC_BAY_ID;
  });

  it("dispatches typed project-control requests through the fabric client", async () => {
    requestMock.mockResolvedValue({ data: null });
    const { getInterBayBridge } = await import("./bridge");
    const bridge = getInterBayBridge();
    await bridge.projectControl("bay-0").start({ project_id: "p1" } as any);
    expect(requestMock).toHaveBeenCalledWith(
      "bay.bay-0.rpc.project-control.start",
      {
        name: "start",
        args: [{ project_id: "p1" }],
      },
      { timeout: 10 * 1000, waitForInterest: true },
    );
  });

  it("dispatches typed bay-directory requests through the fabric client", async () => {
    requestMock.mockResolvedValue({ data: { bay_id: "bay-2", epoch: 0 } });
    const { getInterBayBridge } = await import("./bridge");
    const bridge = getInterBayBridge();
    await expect(
      bridge.directory("bay-2").resolveProjectBay({ project_id: "p1" } as any),
    ).resolves.toEqual({ bay_id: "bay-2", epoch: 0 });
    expect(requestMock).toHaveBeenCalledWith(
      "bay.bay-2.rpc.directory.resolve-project-bay",
      {
        name: "resolveProjectBay",
        args: [{ project_id: "p1" }],
      },
      { timeout: 10 * 1000, waitForInterest: true },
    );
  });

  it("dispatches typed project stop requests through the fabric client", async () => {
    requestMock.mockResolvedValue({ data: null });
    const { getInterBayBridge } = await import("./bridge");
    const bridge = getInterBayBridge();
    await bridge.projectControl("bay-0").stop({ project_id: "p1" } as any);
    expect(requestMock).toHaveBeenCalledWith(
      "bay.bay-0.rpc.project-control.stop",
      {
        name: "stop",
        args: [{ project_id: "p1" }],
      },
      { timeout: 10 * 1000, waitForInterest: true },
    );
  });

  it("dispatches typed project restart requests through the fabric client", async () => {
    requestMock.mockResolvedValue({ data: null });
    const { getInterBayBridge } = await import("./bridge");
    const bridge = getInterBayBridge();
    await bridge.projectControl("bay-0").restart({ project_id: "p1" } as any);
    expect(requestMock).toHaveBeenCalledWith(
      "bay.bay-0.rpc.project-control.restart",
      {
        name: "restart",
        args: [{ project_id: "p1" }],
      },
      { timeout: 10 * 1000, waitForInterest: true },
    );
  });

  it("dispatches typed project backup requests through the fabric client", async () => {
    requestMock.mockResolvedValue({
      data: {
        op_id: "op-1",
        kind: "project-backup",
        scope_type: "project",
        scope_id: "p1",
        status: "succeeded",
      },
    });
    const { getInterBayBridge } = await import("./bridge");
    const bridge = getInterBayBridge();
    await expect(
      bridge
        .projectControl("bay-0")
        .backup({ project_id: "p1", account_id: "a1" } as any),
    ).resolves.toMatchObject({
      op_id: "op-1",
      kind: "project-backup",
      status: "succeeded",
    });
    expect(requestMock).toHaveBeenCalledWith(
      "bay.bay-0.rpc.project-control.backup",
      {
        name: "backup",
        args: [{ project_id: "p1", account_id: "a1" }],
      },
      { timeout: 10 * 1000, waitForInterest: true },
    );
  });

  it("dispatches typed project state requests through the fabric client", async () => {
    requestMock.mockResolvedValue({
      data: { state: "running", ip: "10.0.0.1" },
    });
    const { getInterBayBridge } = await import("./bridge");
    const bridge = getInterBayBridge();
    await expect(
      bridge.projectControl("bay-0").state({ project_id: "p1" } as any),
    ).resolves.toEqual({ state: "running", ip: "10.0.0.1" });
    expect(requestMock).toHaveBeenCalledWith(
      "bay.bay-0.rpc.project-control.state",
      {
        name: "state",
        args: [{ project_id: "p1" }],
      },
      { timeout: 10 * 1000, waitForInterest: true },
    );
  });

  it("dispatches typed project address requests through the fabric client", async () => {
    requestMock.mockResolvedValue({
      data: { host: "10.0.0.1", port: 443, secret_token: "secret" },
    });
    const { getInterBayBridge } = await import("./bridge");
    const bridge = getInterBayBridge();
    await expect(
      bridge
        .projectControl("bay-0")
        .address({ project_id: "p1", account_id: "a1" } as any),
    ).resolves.toEqual({
      host: "10.0.0.1",
      port: 443,
      secret_token: "secret",
    });
    expect(requestMock).toHaveBeenCalledWith(
      "bay.bay-0.rpc.project-control.address",
      {
        name: "address",
        args: [{ project_id: "p1", account_id: "a1" }],
      },
      { timeout: 10 * 1000, waitForInterest: true },
    );
  });

  it("dispatches typed project active-op requests through the fabric client", async () => {
    requestMock.mockResolvedValue({
      data: {
        project_id: "p1",
        op_id: "op-1",
        kind: "project-start",
        action: "start",
        status: "running",
        started_by_account_id: "a1",
        source_bay_id: "bay-1",
        phase: "runner_start",
        message: "starting",
        progress: 86,
        detail: null,
        started_at: new Date("2026-04-08T10:00:00Z"),
        updated_at: new Date("2026-04-08T10:00:01Z"),
      },
    });
    const { getInterBayBridge } = await import("./bridge");
    const bridge = getInterBayBridge();
    await expect(
      bridge.projectControl("bay-0").activeOp({ project_id: "p1" } as any),
    ).resolves.toMatchObject({
      project_id: "p1",
      op_id: "op-1",
      kind: "project-start",
      action: "start",
    });
    expect(requestMock).toHaveBeenCalledWith(
      "bay.bay-0.rpc.project-control.active-op",
      {
        name: "activeOp",
        args: [{ project_id: "p1" }],
      },
      { timeout: 10 * 1000, waitForInterest: true },
    );
  });

  it("forwards remote-bay typed requests to the same fabric", async () => {
    requestMock.mockResolvedValue({ data: null });
    const { getInterBayBridge } = await import("./bridge");
    const bridge = getInterBayBridge();
    await expect(
      bridge.projectControl("bay-1").start({ project_id: "p1" } as any),
    ).resolves.toBeNull();
  });

  it("dispatches typed project reference requests through the fabric client", async () => {
    requestMock.mockResolvedValue({
      data: {
        project_id: "p1",
        title: "Project",
        host_id: "h1",
        owning_bay_id: "bay-0",
      },
    });
    const { getInterBayBridge } = await import("./bridge");
    const bridge = getInterBayBridge();
    await expect(
      bridge
        .projectReference("bay-0")
        .get({ project_id: "p1", account_id: "a1" } as any),
    ).resolves.toEqual({
      project_id: "p1",
      title: "Project",
      host_id: "h1",
      owning_bay_id: "bay-0",
    });
    expect(requestMock).toHaveBeenCalledWith(
      "bay.bay-0.rpc.project-reference.get",
      {
        name: "get",
        args: [{ project_id: "p1", account_id: "a1" }],
      },
      { timeout: 10 * 1000, waitForInterest: true },
    );
  });

  it("dispatches typed project lro progress forwarding requests through the fabric client", async () => {
    requestMock.mockResolvedValue({ data: null });
    const { getInterBayBridge } = await import("./bridge");
    const bridge = getInterBayBridge();
    await bridge.projectLro("bay-0").publishProgress({
      project_id: "p1",
      op_id: "op-1",
      event: {
        type: "progress",
        ts: 1,
        phase: "runner_start",
        message: "starting",
        progress: 86,
      },
    });
    expect(requestMock).toHaveBeenCalledWith(
      "bay.bay-0.rpc.project-lro.publish-progress",
      {
        name: "publishProgress",
        args: [
          {
            project_id: "p1",
            op_id: "op-1",
            event: {
              type: "progress",
              ts: 1,
              phase: "runner_start",
              message: "starting",
              progress: 86,
            },
          },
        ],
      },
      { timeout: 10 * 1000, waitForInterest: true },
    );
  });

  it("dispatches typed host-control start requests through the fabric client", async () => {
    requestMock.mockResolvedValue({ data: { project_id: "p1" } });
    const { getInterBayBridge } = await import("./bridge");
    const bridge = getInterBayBridge();
    await expect(
      bridge.hostControl("bay-0").startProject({
        host_id: "h1",
        start: { project_id: "p1" },
      } as any),
    ).resolves.toEqual({ project_id: "p1" });
    expect(requestMock).toHaveBeenCalledWith(
      "bay.bay-0.rpc.host-control.start-project",
      {
        name: "startProject",
        args: [{ host_id: "h1", start: { project_id: "p1" } }],
      },
      { timeout: 10 * 1000, waitForInterest: true },
    );
  });
});
