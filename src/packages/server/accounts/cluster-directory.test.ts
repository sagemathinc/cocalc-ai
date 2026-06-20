export {};

let queryMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
  getLogger: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: jest.fn(() => "bay-0"),
}));

describe("accounts.cluster-directory", () => {
  beforeEach(() => {
    jest.resetModules();
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("CREATE TABLE") || sql.includes("CREATE INDEX")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("INSERT INTO cluster_account_directory")) {
        return {
          rows: [
            {
              account_id: "11111111-1111-4111-8111-111111111111",
              email_address: "new@example.com",
              display_name: "QA Directory",
              first_name: "QA",
              last_name: "Directory",
              home_bay_id: "bay-2",
              created: null,
              last_active: null,
              banned: false,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("DELETE FROM cluster_account_directory")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("FROM cluster_account_directory")) {
        return {
          rows: [
            {
              account_id: "11111111-1111-4111-8111-111111111111",
              email_address: "qa@example.com",
              display_name: "QA Directory",
              first_name: "QA",
              last_name: "Directory",
              home_bay_id: "bay-2",
              created: null,
              last_active: null,
              banned: false,
            },
          ],
        };
      }
      if (sql.includes("FROM accounts")) {
        return {
          rows: [
            {
              account_id: "11111111-1111-4111-8111-111111111111",
              email_address: "qa@example.com",
              display_name: "QA Local",
              first_name: "QA",
              last_name: "Local",
              home_bay_id: "bay-1",
              created: null,
              last_active: null,
              banned: false,
              email_address_verified: true,
              groups: ["admin"],
            },
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    });
  });

  it("prefers directory home bay over stale local account rows", async () => {
    const { getClusterAccountByIdDirect } = await import("./cluster-directory");
    const account = await getClusterAccountByIdDirect(
      "11111111-1111-4111-8111-111111111111",
    );

    expect(account).toMatchObject({
      account_id: "11111111-1111-4111-8111-111111111111",
      email_address: "qa@example.com",
      last_name: "Directory",
      home_bay_id: "bay-2",
    });
  });

  it("preserves admin-only is_admin across cluster directory merge", async () => {
    const { searchClusterAccountsDirect } = await import("./cluster-directory");
    const [account] = await searchClusterAccountsDirect({
      query: "qa",
      admin: true,
    });

    expect(account).toMatchObject({
      account_id: "11111111-1111-4111-8111-111111111111",
      home_bay_id: "bay-2",
      is_admin: true,
    });
  });

  it("does not add is_admin to non-admin cluster searches", async () => {
    const { searchClusterAccountsDirect } = await import("./cluster-directory");
    const [account] = await searchClusterAccountsDirect({
      query: "qa",
      admin: false,
    });

    expect(account).toMatchObject({
      account_id: "11111111-1111-4111-8111-111111111111",
      home_bay_id: "bay-2",
    });
    expect(account.is_admin).toBeUndefined();
  });

  it("upserts email address reservations through the directory", async () => {
    const { updateClusterAccountEmailAddressDirect } =
      await import("./cluster-directory");
    const account = await updateClusterAccountEmailAddressDirect({
      account_id: "11111111-1111-4111-8111-111111111111",
      email_address: "NEW@example.com",
    });

    expect(account.email_address).toBe("new@example.com");
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT (account_id) DO UPDATE"),
      [
        "11111111-1111-4111-8111-111111111111",
        "new@example.com",
        "QA Directory",
        "QA",
        "Directory",
        "bay-2",
      ],
    );
  });

  it("uses provider-specific matching when finding equivalent banned accounts", async () => {
    const { getClusterBanEquivalentEmailAccountsDirect } =
      await import("./cluster-directory");

    await getClusterBanEquivalentEmailAccountsDirect({
      email_address: "Co.Dex+abuse@googlemail.com",
    });
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining("$1"), [
      "codex",
      ["gmail.com", "googlemail.com"],
      1000,
      "bay-0",
    ]);

    await getClusterBanEquivalentEmailAccountsDirect({
      email_address: "co.dex+abuse@outlook.com",
    });
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining("$1"), [
      "co.dex",
      ["outlook.com"],
      1000,
      "bay-0",
    ]);

    await getClusterBanEquivalentEmailAccountsDirect({
      email_address: "codex-abuse@yahoo.com",
    });
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("position('-'"),
      ["codex", ["yahoo.com"], 1000, "bay-0"],
    );
  });

  it("touches directory account activity without scanning accounts", async () => {
    const { touchClusterAccountDirectoryEntryDirect } =
      await import("./cluster-directory");

    await touchClusterAccountDirectoryEntryDirect(
      "11111111-1111-4111-8111-111111111111",
    );

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("SET last_active=NOW()"),
      ["11111111-1111-4111-8111-111111111111"],
    );
  });

  it("deletes stale local directory rows by email", async () => {
    const { deleteStaleLocalClusterAccountDirectoryEntryByEmail } =
      await import("./cluster-directory");

    await deleteStaleLocalClusterAccountDirectoryEntryByEmail(
      "STALE@example.com",
    );

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM cluster_account_directory"),
      ["stale@example.com", "bay-0"],
    );
  });
});
