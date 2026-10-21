/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const calls: string[] = [];
const clientDeleteMock = jest.fn();
const poolQueryMock = jest.fn();

jest.mock("./client", () => ({
  __esModule: true,
  default: async () => ({ delete: clientDeleteMock }),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: poolQueryMock }),
}));

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

describe("deleting the salesloft person of a deleted account", () => {
  beforeEach(() => {
    calls.length = 0;
    clientDeleteMock.mockReset().mockImplementation(async (url) => {
      calls.push(`delete ${url}`);
    });
    poolQueryMock.mockReset().mockImplementation(async (sql) => {
      calls.push(sql.startsWith("UPDATE accounts") ? "clear link" : sql);
      return { rows: [], rowCount: 1 };
    });
  });

  it("deletes the remote person before clearing the local link", async () => {
    const { destroyForDeletedAccount } = await import("./people");
    await destroyForDeletedAccount(ACCOUNT_ID, "42");
    expect(calls).toEqual(["delete /people/42", "clear link"]);
    // a hung request cannot block the deletion pass
    expect(clientDeleteMock.mock.calls[0][1]).toEqual({ timeout: 30_000 });
    expect(poolQueryMock.mock.calls[0][1]).toEqual([ACCOUNT_ID, "42"]);
  });

  it("treats a person that is already gone as deleted", async () => {
    clientDeleteMock.mockRejectedValue({ response: { status: 404 } });
    const { destroyForDeletedAccount } = await import("./people");
    await destroyForDeletedAccount(ACCOUNT_ID, "42");
    expect(calls).toEqual(["clear link"]);
  });

  it("keeps the link when the remote delete fails, so it is retried", async () => {
    clientDeleteMock.mockRejectedValue({ response: { status: 500 } });
    const { destroyForDeletedAccount } = await import("./people");
    await expect(destroyForDeletedAccount(ACCOUNT_ID, "42")).rejects.toEqual({
      response: { status: 500 },
    });
    expect(poolQueryMock).not.toHaveBeenCalled();
  });
});
