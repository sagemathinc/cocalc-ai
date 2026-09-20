/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

const queryMock = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...args: any[]) => queryMock(...args) }),
}));

describe("Codex payment source project-host authorization", () => {
  const account_id = "11111111-1111-4111-8111-111111111111";
  const project_id = "22222222-2222-4222-8222-222222222222";
  const host_id = "33333333-3333-4333-8333-333333333333";

  beforeEach(() => queryMock.mockReset());

  it("accepts the assigned host for a collaborator account", async () => {
    queryMock.mockResolvedValue({ rowCount: 1 });
    const { assertCodexPaymentSourceCaller } = await import("./system");

    await expect(
      assertCodexPaymentSourceCaller({ account_id, project_id, host_id }),
    ).resolves.toBeUndefined();

    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining("users ?"), [
      project_id,
      host_id,
      account_id,
    ]);
  });

  it("rejects an unassigned host or non-collaborator account", async () => {
    queryMock.mockResolvedValue({ rowCount: 0 });
    const { assertCodexPaymentSourceCaller } = await import("./system");

    await expect(
      assertCodexPaymentSourceCaller({ account_id, project_id, host_id }),
    ).rejects.toThrow(
      "project host is not authorized for this account payment source",
    );
  });

  it("requires hosts to bind the lookup to a project", async () => {
    const { assertCodexPaymentSourceCaller } = await import("./system");

    await expect(
      assertCodexPaymentSourceCaller({ account_id, host_id }),
    ).rejects.toThrow("project_id is required");
    expect(queryMock).not.toHaveBeenCalled();
  });
});
