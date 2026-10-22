/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const poolQueryMock = jest.fn();
const deleteAccountMock = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: poolQueryMock }),
}));

jest.mock("@cocalc/server/accounts/delete", () => ({
  __esModule: true,
  default: (...args: any[]) => deleteAccountMock(...args),
}));

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

describe("only_if_tag guard on local account deletion", () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
    deleteAccountMock.mockReset().mockResolvedValue(undefined);
  });

  it("refuses a live account without the tag", async () => {
    poolQueryMock.mockResolvedValue({ rows: [{ tags: [], deleted: false }] });
    const { deleteLocalClusterAccount } = await import("./accounts");
    await expect(
      deleteLocalClusterAccount({ account_id: ACCOUNT_ID, only_if_tag: "e2e" }),
    ).rejects.toThrow("missing required tag 'e2e'");
    expect(deleteAccountMock).not.toHaveBeenCalled();
  });

  it("allows a retry for an already deleted account, whose tags are cleared", async () => {
    poolQueryMock.mockResolvedValue({ rows: [{ tags: null, deleted: true }] });
    const { deleteLocalClusterAccount } = await import("./accounts");
    await deleteLocalClusterAccount({
      account_id: ACCOUNT_ID,
      only_if_tag: "e2e",
    });
    expect(deleteAccountMock).toHaveBeenCalledWith(ACCOUNT_ID, {
      initiator: "system",
      actor_account_id: undefined,
    });
  });
});
