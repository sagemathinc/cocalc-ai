/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let configuredBayId = "bay-0";
let getLroStreamMock: jest.Mock;
let publishProgressMock: jest.Mock;

jest.mock("@cocalc/backend/conat", () => ({
  __esModule: true,
  conat: jest.fn(() => ({ id: "client" })),
}));

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock("@cocalc/conat/lro/client", () => ({
  __esModule: true,
  get: (...args: any[]) => getLroStreamMock(...args),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  __esModule: true,
  getConfiguredBayId: jest.fn(() => configuredBayId),
}));

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  __esModule: true,
  getInterBayBridge: jest.fn(() => ({
    projectLro: jest.fn(() => ({
      publishProgress: (...args: any[]) => publishProgressMock(...args),
    })),
  })),
}));

jest.mock("@cocalc/server/projects/active-operation", () => ({
  __esModule: true,
  updateProjectActiveOperationProgress: jest.fn(async () => undefined),
}));

describe("forwardRemoteStartLroProgress", () => {
  beforeEach(() => {
    jest.resetModules();
    configuredBayId = "bay-0";
    getLroStreamMock = jest.fn();
    publishProgressMock = jest.fn(async () => undefined);
  });

  it("does nothing for same-bay starts", async () => {
    const { forwardRemoteStartLroProgress } =
      await import("./start-lro-forward");

    const close = await forwardRemoteStartLroProgress({
      project_id: "00000000-0000-4000-8000-000000000001",
      op_id: "00000000-0000-4000-8000-000000000002",
      source_bay_id: "bay-0",
    });

    expect(getLroStreamMock).not.toHaveBeenCalled();
    await expect(close()).resolves.toBeUndefined();
  });

  it("does not block cross-bay starts while opening the progress stream", async () => {
    configuredBayId = "bay-1";
    getLroStreamMock.mockImplementation(() => new Promise(() => undefined));
    const { forwardRemoteStartLroProgress } =
      await import("./start-lro-forward");

    const close = await Promise.race([
      forwardRemoteStartLroProgress({
        project_id: "00000000-0000-4000-8000-000000000001",
        op_id: "00000000-0000-4000-8000-000000000002",
        source_bay_id: "bay-0",
      }),
      new Promise<"timeout">((resolve) => setTimeout(resolve, 25, "timeout")),
    ]);

    expect(close).not.toBe("timeout");
    expect(getLroStreamMock).toHaveBeenCalledTimes(1);
    if (close !== "timeout") {
      await expect(close()).resolves.toBeUndefined();
    }
  });
});
