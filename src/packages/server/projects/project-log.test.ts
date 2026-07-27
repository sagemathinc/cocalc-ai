/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let getExplicitProjectRoutedClientMock: jest.Mock;
let dstreamMock: jest.Mock;

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    warn: jest.fn(),
  })),
}));

jest.mock("@cocalc/server/conat/route-client", () => ({
  getExplicitProjectRoutedClient: (...args: any[]) =>
    getExplicitProjectRoutedClientMock(...args),
}));

describe("appendProjectLogRowBestEffort", () => {
  beforeEach(() => {
    jest.resetModules();
    dstreamMock = jest.fn(async () => ({
      getAll: jest.fn(() => []),
      publish: jest.fn(),
      save: jest.fn(async () => undefined),
      close: jest.fn(),
    }));
    getExplicitProjectRoutedClientMock = jest.fn(async () => ({
      sync: {
        dstream: (...args: any[]) => dstreamMock(...args),
      },
    }));
  });

  it("does not retry stream bootstrap when project routing is unavailable", async () => {
    const { appendProjectLogRowBestEffort } = await import("./project-log");

    await expect(
      appendProjectLogRowBestEffort({
        project_id: "11111111-1111-4111-8111-111111111111",
        row: {
          id: "log-1",
          project_id: "11111111-1111-4111-8111-111111111111",
          account_id: "22222222-2222-4222-8222-222222222222",
          time: new Date(),
          event: { event: "test" },
        },
      }),
    ).resolves.toBe(true);

    expect(dstreamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "11111111-1111-4111-8111-111111111111",
        bootstrapRetry: false,
      }),
    );
  });
});
