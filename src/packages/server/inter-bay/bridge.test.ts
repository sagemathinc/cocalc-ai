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
});
