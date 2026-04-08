/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

const dispatchProjectControlRpcMock = jest.fn();

jest.mock("@cocalc/server/inter-bay/project-control", () => ({
  __esModule: true,
  dispatchProjectControlRpc: (...args: any[]) =>
    dispatchProjectControlRpcMock(...args),
}));

describe("inter-bay bridge", () => {
  beforeEach(() => {
    jest.resetModules();
    dispatchProjectControlRpcMock.mockReset();
    delete process.env.COCALC_BAY_ID;
  });

  it("dispatches local requests through the local bridge handler", async () => {
    dispatchProjectControlRpcMock.mockResolvedValue("ok");
    const { getInterBayBridge } = await import("./bridge");
    const bridge = getInterBayBridge();
    await expect(
      bridge.request({
        dest_bay: "bay-0",
        subject: "bay.bay-0.rpc.project-control.start",
        data: { project_id: "p1" },
      }),
    ).resolves.toBe("ok");
    expect(dispatchProjectControlRpcMock).toHaveBeenCalledWith(
      "bay.bay-0.rpc.project-control.start",
      { project_id: "p1" },
    );
  });

  it("fails fast for remote bays until the real transport exists", async () => {
    const { getInterBayBridge } = await import("./bridge");
    const bridge = getInterBayBridge();
    await expect(
      bridge.request({
        dest_bay: "bay-1",
        subject: "bay.bay-1.rpc.project-control.start",
        data: {},
      }),
    ).rejects.toThrow("inter-bay transport not implemented yet");
  });
});
