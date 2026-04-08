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

  it("forwards remote-bay typed requests to the same fabric", async () => {
    requestMock.mockResolvedValue({ data: null });
    const { getInterBayBridge } = await import("./bridge");
    const bridge = getInterBayBridge();
    await expect(
      bridge.projectControl("bay-1").start({ project_id: "p1" } as any),
    ).resolves.toBeNull();
  });
});
