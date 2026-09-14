/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import getCostPerDay from "./get-cost-per-day";

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(),
}));

const mockGetPool = jest.mocked(getPool);

describe("getCostPerDay pagination", () => {
  const query = jest.fn(async () => ({ rows: [] }));

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetPool.mockReturnValue({ query } as any);
  });

  it("binds validated pagination values as query parameters", async () => {
    await getCostPerDay({
      account_id: "11111111-1111-4111-8111-111111111111",
      limit: 25,
      offset: 50,
    });

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("LIMIT $2 OFFSET $3");
    expect(sql).not.toContain("LIMIT 25");
    expect(params).toEqual(["11111111-1111-4111-8111-111111111111", 25, 50]);
  });

  it("uses bounded defaults", async () => {
    await getCostPerDay({
      account_id: "11111111-1111-4111-8111-111111111111",
    });

    expect(query.mock.calls[0][1]).toEqual([
      "11111111-1111-4111-8111-111111111111",
      100,
      0,
    ]);
  });

  it.each([
    ["SQL expression", "(SELECT 1)"],
    ["numeric string", "25"],
    ["fraction", 1.5],
    ["zero", 0],
    ["negative", -1],
    ["above maximum", 1_001],
    ["not a number", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
  ])("rejects an invalid %s limit", async (_name, limit) => {
    await expect(
      getCostPerDay({
        account_id: "11111111-1111-4111-8111-111111111111",
        limit: limit as number,
      }),
    ).rejects.toThrow("limit must be an integer between 1 and 1000");
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    ["SQL expression", "(SELECT 1)"],
    ["numeric string", "50"],
    ["fraction", 1.5],
    ["negative", -1],
    ["not a number", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
  ])("rejects an invalid %s offset", async (_name, offset) => {
    await expect(
      getCostPerDay({
        account_id: "11111111-1111-4111-8111-111111111111",
        offset: offset as number,
      }),
    ).rejects.toThrow("offset must be an integer at least 0");
    expect(query).not.toHaveBeenCalled();
  });
});
