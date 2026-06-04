/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let isAdminMock: jest.Mock;
let queryMock: jest.Mock;
let requireDangerousSessionAuthMock: jest.Mock;
let bayIdMock: jest.Mock;
let seedBayIdMock: jest.Mock;
let getInterBayFabricClientMock: jest.Mock;
let seedSoftwareLicenseClientMock: Record<string, jest.Mock>;

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

jest.mock("@cocalc/server/bay-config", () => ({
  __esModule: true,
  getConfiguredBayId: (...args: any[]) => bayIdMock(...args),
}));

jest.mock("@cocalc/server/cluster-config", () => ({
  __esModule: true,
  getConfiguredClusterSeedBayId: (...args: any[]) => seedBayIdMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  __esModule: true,
  getInterBayFabricClient: (...args: any[]) =>
    getInterBayFabricClientMock(...args),
}));

jest.mock("@cocalc/conat/inter-bay/api", () => ({
  __esModule: true,
  createInterBayAccountLocalClient: jest.fn(
    () => seedSoftwareLicenseClientMock,
  ),
}));

describe("software license dangerous-session auth", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    jest.resetModules();
    isAdminMock = jest.fn(async () => true);
    queryMock = jest.fn(async () => ({ rows: [] }));
    requireDangerousSessionAuthMock = jest.fn(async () => ({}));
    bayIdMock = jest.fn(() => "seed");
    seedBayIdMock = jest.fn(() => "seed");
    getInterBayFabricClientMock = jest.fn(() => "fabric");
    seedSoftwareLicenseClientMock = {
      listSoftwareLicenseTiers: jest.fn(async () => []),
      upsertSoftwareLicenseTier: jest.fn(async () => undefined),
      listSoftwareLicenses: jest.fn(async () => []),
      createSoftwareLicense: jest.fn(async () => ({ id: "license-1" })),
      revokeSoftwareLicense: jest.fn(async () => undefined),
      restoreSoftwareLicense: jest.fn(async () => undefined),
      listOwnedSoftwareLicenses: jest.fn(async () => []),
    };
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

  it("forwards software license writes from attached bays to the seed after fresh auth", async () => {
    bayIdMock = jest.fn(() => "attached-bay");
    seedBayIdMock = jest.fn(() => "seed");
    const { createLicense } = await import("./software");

    await createLicense({
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
      session_hash: "session-hash",
      tier_id: "rocket-pro",
      owner_account_id: "22222222-2222-4222-8222-222222222222",
    });

    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
      session_hash: "session-hash",
      require_second_factor: true,
    });
    expect(
      seedSoftwareLicenseClientMock.createSoftwareLicense,
    ).toHaveBeenCalledWith({
      actor_account_id: ACCOUNT_ID,
      tier_id: "rocket-pro",
      owner_account_id: "22222222-2222-4222-8222-222222222222",
      product: "launchpad",
      expires_at: undefined,
      limits: undefined,
      features: undefined,
      notes: undefined,
    });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("forwards owned license listing from attached bays to the seed", async () => {
    bayIdMock = jest.fn(() => "attached-bay");
    seedBayIdMock = jest.fn(() => "seed");
    const { listMyLicenses } = await import("./software");

    await listMyLicenses({ account_id: ACCOUNT_ID });

    expect(
      seedSoftwareLicenseClientMock.listOwnedSoftwareLicenses,
    ).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
    });
    expect(queryMock).not.toHaveBeenCalled();
  });
});
