/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let waitForCompletionMock: jest.Mock;
let getLroMock: jest.Mock;

jest.mock("@cocalc/conat/lro/client", () => ({
  __esModule: true,
  waitForCompletion: (...args: any[]) => waitForCompletionMock(...args),
}));

jest.mock("@cocalc/server/lro/lro-db", () => ({
  __esModule: true,
  getLro: (...args: any[]) => getLroMock(...args),
}));

describe("server lro durable wait", () => {
  beforeEach(() => {
    getLroMock = jest.fn(async () => ({
      op_id: "op-1",
      scope_type: "project",
      scope_id: "project-1",
      status: "succeeded",
      result: { ok: true },
    }));
    waitForCompletionMock = jest.fn(async ({ getSummary }) => {
      expect(typeof getSummary).toBe("function");
      return await getSummary();
    });
  });

  it("adds a durable database summary fallback when an op_id is available", async () => {
    const { waitForDurableLroCompletion } = await import("./wait");
    const summary = await waitForDurableLroCompletion({
      op_id: "op-1",
      scope_type: "project",
      scope_id: "project-1",
      client: {} as any,
    });

    expect(summary).toEqual(
      expect.objectContaining({
        op_id: "op-1",
        status: "succeeded",
      }),
    );
    expect(getLroMock).toHaveBeenCalledWith("op-1");
  });

  it("keeps a caller-provided summary authoritative", async () => {
    const { waitForDurableLroCompletion } = await import("./wait");
    const callerSummary = {
      op_id: "op-2",
      scope_type: "project",
      scope_id: "project-2",
      status: "failed",
      error: "caller summary",
    };

    const summary = await waitForDurableLroCompletion({
      op_id: "op-2",
      scope_type: "project",
      scope_id: "project-2",
      client: {} as any,
      getSummary: async () => callerSummary as any,
    });

    expect(summary).toBe(callerSummary);
    expect(getLroMock).not.toHaveBeenCalled();
  });
});
