/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

export {};

const queryMock = jest.fn();
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...args: any[]) => queryMock(...args) }),
}));

describe("rollbackProjectHostOverSshInternal", () => {
  it("refuses an unsafe rollback version before changing anything", async () => {
    const reconcile = jest.fn(async () => undefined);
    const { rollbackProjectHostOverSshInternal } =
      await import("./hosts-project-host-rollbacks");
    await expect(
      rollbackProjectHostOverSshInternal({
        row: { id: "host-1", metadata: {} },
        requested_by: "admin-account",
        version: "../x",
        reconcileCloudHostBootstrapOverSsh: reconcile,
      }),
    ).rejects.toThrow("invalid host software version or channel");
    expect(reconcile).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });
});
