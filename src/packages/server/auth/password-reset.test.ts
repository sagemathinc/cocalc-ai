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

describe("password reset redemption", () => {
  beforeEach(() => {
    jest.resetModules();
    queryMock = jest.fn().mockResolvedValue({
      rows: [{ email_address: "USER@example.COM" }],
    });
  });

  it("atomically consumes the reset token while returning the email", async () => {
    const { redeemResetLocal } = await import("./password-reset");

    await expect(
      redeemResetLocal("00000000-1000-4000-8000-000000000001"),
    ).resolves.toEqual({ email_address: "user@example.com" });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const sql = queryMock.mock.calls[0][0];
    expect(sql).toContain("UPDATE password_reset");
    expect(sql).toContain("AND expire > NOW()");
    expect(sql).toContain("RETURNING email_address");
  });

  it("rejects already-consumed or expired reset tokens", async () => {
    queryMock = jest.fn().mockResolvedValue({ rows: [] });
    const { redeemResetLocal } = await import("./password-reset");

    await expect(
      redeemResetLocal("00000000-1000-4000-8000-000000000001"),
    ).rejects.toThrow("Password reset no longer valid.");
  });
});
