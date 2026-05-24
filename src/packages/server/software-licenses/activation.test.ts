/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let queryMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...args: any[]) => queryMock(...args) }),
}));

jest.mock("uuid", () => ({
  v4: () => "11111111-1111-4111-8111-111111111111",
}));

describe("software license activation", () => {
  beforeEach(() => {
    jest.resetModules();
    queryMock = jest.fn(async () => ({ rows: [] }));
  });

  it("deduplicates activation events while still refreshing the license", async () => {
    const { recordActivationRefresh } = await import("./activation");

    await recordActivationRefresh({
      license_id: "22222222-2222-4222-8222-222222222222",
      instance_id: " instance-1 ",
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("WHERE NOT EXISTS");
    expect(sql).toContain("software_license_events");
    expect(sql).toContain("last_refresh_at = NOW()");
    expect(params).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      JSON.stringify({ instance_id: "instance-1" }),
      "instance-1",
      "24 hours",
    ]);
  });
});
