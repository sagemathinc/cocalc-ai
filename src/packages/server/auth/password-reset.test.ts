/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let queryMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...args: any[]) => queryMock(...args) }),
}));

describe("password reset throttling", () => {
  beforeEach(() => {
    jest.resetModules();
    queryMock = jest.fn().mockResolvedValue({ rows: [{ count: 4 }] });
  });

  it("counts recent attempts by email globally and IP globally", async () => {
    const { recentAttemptsLocal } = await import("./password-reset");

    await expect(
      recentAttemptsLocal("USER@example.COM", "192.0.2.44"),
    ).resolves.toBe(4);

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("GREATEST"),
      ["USER@example.COM", "192.0.2.44"],
    );
    const sql = queryMock.mock.calls[0][0];
    expect(sql).toContain("COUNT(*) FILTER (WHERE email_address=$1)");
    expect(sql).toContain("COUNT(*) FILTER (WHERE ip_address=$2::INET)");
    expect(sql).not.toContain("AND ip_address=$2::INET)::INT");
  });
});
