/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let isAdminMock: jest.Mock;
let queryMock: jest.Mock;
let requireDangerousSessionAuthMock: jest.Mock;

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: queryMock }),
}));

jest.mock("./dangerous-session-auth", () => ({
  __esModule: true,
  requireDangerousSessionAuth: (...args: any[]) =>
    requireDangerousSessionAuthMock(...args),
}));

describe("software license dangerous-session auth", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    jest.resetModules();
    isAdminMock = jest.fn(async () => true);
    queryMock = jest.fn(async () => ({ rows: [] }));
    requireDangerousSessionAuthMock = jest.fn(async () => ({}));
  });

  it("requires recent 2FA fresh auth before software license tier edits", async () => {
    const { upsertLicenseTier } = await import("./software");

    await upsertLicenseTier({
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
      session_hash: "session-hash",
      tier: {
        id: "rocket-pro",
        label: "Rocket Pro",
      },
    });

    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
      session_hash: "session-hash",
      require_second_factor: true,
    });
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO software_license_tiers"),
      expect.any(Array),
    );
  });

  it.each([
    ["createLicense", { tier_id: "rocket-pro" }],
    ["revokeLicense", { license_id: "license-1" }],
    ["restoreLicense", { license_id: "license-1" }],
  ] as const)(
    "requires fresh auth before %s touches the database",
    async (method, args) => {
      const err = Object.assign(new Error("fresh auth is required"), {
        code: "fresh_auth_required",
      });
      requireDangerousSessionAuthMock = jest.fn(async () => {
        throw err;
      });
      const software = await import("./software");

      await expect(
        (software[method] as any)({
          account_id: ACCOUNT_ID,
          browser_id: "browser-1",
          ...args,
        }),
      ).rejects.toThrow("fresh auth is required");

      expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
        account_id: ACCOUNT_ID,
        browser_id: "browser-1",
        session_hash: undefined,
        require_second_factor: true,
      });
      expect(queryMock).not.toHaveBeenCalled();
    },
  );

  it("does not require fresh auth for read-only admin listing", async () => {
    const { listLicenseTiers } = await import("./software");

    await listLicenseTiers({
      account_id: ACCOUNT_ID,
      include_disabled: true,
    });

    expect(requireDangerousSessionAuthMock).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledWith(
      "SELECT * FROM software_license_tiers  ORDER BY id ASC",
    );
  });

  it("does not return bearer tokens in broad admin license listings", async () => {
    const { listLicenses } = await import("./software");

    await listLicenses({
      account_id: ACCOUNT_ID,
      limit: 10,
    });

    const sql = `${queryMock.mock.calls[0][0]}`;
    expect(sql).toContain("SELECT id, tier_id, owner_account_id");
    expect(sql).not.toContain("token");
  });
});
