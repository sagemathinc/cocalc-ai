/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let queryMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...args: any[]) => queryMock(...args) }),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  __esModule: true,
  getConfiguredBayId: () => "bay-0",
}));

import { getPressurePolicy } from "./pressure-policy";

const row = (over: Record<string, unknown>) => ({
  rows: [{ tier: null, bay_id: "bay-0", ...over }],
});

describe("getPressurePolicy", () => {
  beforeEach(() => {
    queryMock = jest.fn(async () => row({}));
  });

  it("a host outside the shared pool is watch-only", async () => {
    const policy = await getPressurePolicy({ host_id: "host-1" });
    expect(policy).toMatchObject({
      host_id: "host-1",
      watch_only: true,
      reason: "private_host",
    });
    expect(Number.isFinite(Date.parse(policy.evaluated_at))).toBe(true);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("deleted IS NULL");
    expect(params).toEqual(["host-1"]);
  });

  it.each([0, 1, 3])("a shared-pool host (tier %p) is not watch-only", async (tier) => {
    queryMock = jest.fn(async () => row({ tier }));
    await expect(getPressurePolicy({ host_id: "host-1" })).resolves.toMatchObject(
      { watch_only: false, reason: "shared_pool" },
    );
  });

  it("refuses a caller without a host id", async () => {
    await expect(getPressurePolicy({})).rejects.toThrow("host_id");
    await expect(getPressurePolicy()).rejects.toThrow("host_id");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("answers no value for an unknown or deleted host", async () => {
    queryMock = jest.fn(async () => ({ rows: [] }));
    await expect(getPressurePolicy({ host_id: "host-1" })).rejects.toThrow(
      "host not found",
    );
  });

  it.each([["bay-1"], [null], [""]])(
    "answers no value for a host this bay does not own (bay_id %p)",
    async (bay_id) => {
      queryMock = jest.fn(async () => row({ bay_id }));
      await expect(getPressurePolicy({ host_id: "host-1" })).rejects.toThrow(
        "not owned by this bay",
      );
    },
  );
});
