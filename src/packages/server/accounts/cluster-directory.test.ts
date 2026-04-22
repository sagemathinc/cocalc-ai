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
      if (sql.includes("FROM accounts")) {
        return {
          rows: [
            {
              account_id: "11111111-1111-4111-8111-111111111111",
              email_address: "qa@example.com",
              first_name: "QA",
              last_name: "Local",
              name: null,
              home_bay_id: "bay-1",
              created: null,
              last_active: null,
              banned: false,
              email_address_verified: true,
            },
          ],
        };
      }
      if (sql.includes("FROM cluster_account_directory")) {
        return {
          rows: [
            {
              account_id: "11111111-1111-4111-8111-111111111111",
              email_address: "qa@example.com",
              first_name: "QA",
              last_name: "Directory",
              name: null,
              home_bay_id: "bay-2",
              created: null,
              last_active: null,
              banned: false,
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
});
