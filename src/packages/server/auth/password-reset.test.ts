/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let queryMock: jest.Mock;
const getClusterAccountByEmailDirectMock = jest.fn();
const getClusterAccountByIdDirectMock = jest.fn();
const getFinancialApprovalIdentityDirectMock = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...args: any[]) => queryMock(...args) }),
}));

jest.mock("@cocalc/server/accounts/cluster-directory", () => ({
  getClusterAccountByEmailDirect: (...args: any[]) =>
    getClusterAccountByEmailDirectMock(...args),
  getClusterAccountByIdDirect: (...args: any[]) =>
    getClusterAccountByIdDirectMock(...args),
  getFinancialApprovalIdentityDirect: (...args: any[]) =>
    getFinancialApprovalIdentityDirectMock(...args),
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
      rows: [
        {
          account_id: "00000000-2000-4000-8000-000000000002",
          email_address: "USER@example.COM",
        },
      ],
    });
  });

  it("atomically consumes the reset token while returning the email", async () => {
    const { redeemResetLocal } = await import("./password-reset");

    await expect(
      redeemResetLocal("00000000-1000-4000-8000-000000000001"),
    ).resolves.toEqual({
      account_id: "00000000-2000-4000-8000-000000000002",
      email_address: "user@example.com",
    });

    expect(queryMock).toHaveBeenCalledTimes(2);
    const sql = queryMock.mock.calls[1][0];
    expect(sql).toContain("UPDATE password_reset");
    expect(sql).toContain("reset.expire > NOW()");
    expect(sql).toContain("identity.generation=reset.identity_generation");
    expect(sql).toContain("RETURNING reset.email_address, reset.account_id");
  });

  it("rejects already-consumed or expired reset tokens", async () => {
    queryMock = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const { redeemResetLocal } = await import("./password-reset");

    await expect(
      redeemResetLocal("00000000-1000-4000-8000-000000000001"),
    ).rejects.toThrow("Password reset no longer valid.");
  });
});

describe("password reset issuance", () => {
  beforeEach(() => {
    jest.resetModules();
    queryMock = jest.fn();
    getClusterAccountByEmailDirectMock.mockReset().mockResolvedValue({
      account_id: "00000000-3000-4000-8000-000000000003",
      email_address: "user@example.com",
    });
    getFinancialApprovalIdentityDirectMock.mockReset();
  });

  it("rejects an admin reset when the email now belongs to another account", async () => {
    const { createResetLocal } = await import("./password-reset");

    await expect(
      createResetLocal(
        "user@example.com",
        "",
        3600,
        "00000000-2000-4000-8000-000000000002",
      ),
    ).rejects.toThrow("Account email changed before password reset creation.");
    expect(getFinancialApprovalIdentityDirectMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });
});
