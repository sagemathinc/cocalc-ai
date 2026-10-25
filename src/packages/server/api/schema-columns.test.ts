/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const queryMock = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: queryMock }),
}));

describe("assertSchemaColumns", () => {
  beforeEach(() => {
    jest.resetModules();
    queryMock.mockReset();
  });

  it("only reads the catalog, once per process", async () => {
    queryMock.mockResolvedValue({
      rows: [{ column_name: "a" }, { column_name: "b" }],
    });
    const { assertSchemaColumns } = await import("./schema-columns");
    await assertSchemaColumns("accounts", ["a", "b"]);
    await assertSchemaColumns("accounts", ["b", "a"]);
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql] = queryMock.mock.calls[0];
    expect(sql).toMatch(
      /^\s*SELECT column_name FROM information_schema\.columns/,
    );
    expect(sql).not.toMatch(/ALTER|CREATE|UPDATE|DROP/i);
  });

  it("fails fast naming the missing columns, and checks again later", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ column_name: "a" }] });
    const { assertSchemaColumns } = await import("./schema-columns");
    await expect(assertSchemaColumns("api_keys", ["a", "b"])).rejects.toThrow(
      "api_keys lacks b",
    );
    queryMock.mockResolvedValueOnce({
      rows: [{ column_name: "a" }, { column_name: "b" }],
    });
    await expect(
      assertSchemaColumns("api_keys", ["a", "b"]),
    ).resolves.toBeUndefined();
    expect(queryMock).toHaveBeenCalledTimes(2);
  });
});
