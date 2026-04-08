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

  it("dispatches local requests through the fabric client", async () => {
    requestMock.mockResolvedValue({ data: "ok" });
    const { getInterBayBridge } = await import("./bridge");
    const bridge = getInterBayBridge();
    await expect(
      bridge.request({
        dest_bay: "bay-0",
        subject: "bay.bay-0.rpc.project-control.start",
        data: { project_id: "p1" },
      }),
    ).resolves.toBe("ok");
    expect(requestMock).toHaveBeenCalledWith(
      "bay.bay-0.rpc.project-control.start",
      { project_id: "p1" },
      { timeout: undefined },
    );
  });

  it("forwards remote-bay requests to the same fabric instead of failing fast", async () => {
    requestMock.mockResolvedValue({ data: "remote-ok" });
    const { getInterBayBridge } = await import("./bridge");
    const bridge = getInterBayBridge();
    await expect(
      bridge.request({
        dest_bay: "bay-1",
        subject: "bay.bay-1.rpc.project-control.start",
        data: {},
      }),
    ).resolves.toBe("remote-ok");
  });
});
