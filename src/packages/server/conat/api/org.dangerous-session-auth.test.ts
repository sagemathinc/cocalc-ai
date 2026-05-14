export {};

let isAdminMock: jest.Mock;
let queryMock: jest.Mock;
let requireDangerousSessionAuthMock: jest.Mock;
let withAccountRehomeWriteFenceMock: jest.Mock;

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: queryMock }),
}));

jest.mock("@cocalc/server/accounts/rehome-fence", () => ({
  __esModule: true,
  withAccountRehomeWriteFence: (...args: any[]) =>
    withAccountRehomeWriteFenceMock(...args),
}));

jest.mock("./dangerous-session-auth", () => ({
  __esModule: true,
  requireDangerousSessionAuth: (...args: any[]) =>
    requireDangerousSessionAuthMock(...args),
}));

describe("organization dangerous-session auth", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const USER_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    jest.resetModules();
    isAdminMock = jest.fn(async () => false);
    queryMock = jest.fn(async (sql: string, params?: any[]) => {
      if (sql.includes("SELECT org as name, account_id, email_address")) {
        return {
          rows: [
            {
              name: null,
              account_id: USER_ACCOUNT_ID,
              email_address: params?.[0],
            },
          ],
        };
      }
      if (sql.includes("COUNT(*) AS count FROM organizations")) {
        return {
          rows: [
            {
              count: params?.length === 2 && params[1] === ACCOUNT_ID ? 1 : 0,
            },
          ],
        };
      }
      if (sql.includes("COUNT(*) AS count FROM accounts")) {
        return { rows: [{ count: 0 }] };
      }
      return { rows: [] };
    });
    requireDangerousSessionAuthMock = jest.fn(async () => ({}));
    withAccountRehomeWriteFenceMock = jest.fn(async ({ fn }) => {
      await fn({ query: queryMock });
    });
  });

  it("requires fresh recent 2FA for site-admin organization creation", async () => {
    isAdminMock = jest.fn(async () => true);
    const { create } = await import("./org");
    await create({
      account_id: ACCOUNT_ID,
      session_hash: "session-hash",
      name: "acme",
    });

    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      session_hash: "session-hash",
      require_second_factor: true,
    });
    expect(queryMock).toHaveBeenCalledWith(
      "INSERT INTO organizations(organization_id,name) VALUES($1,$2)",
      [expect.any(String), "acme"],
    );
  });

  it("requires fresh recent 2FA before site-admin user organization moves", async () => {
    isAdminMock = jest.fn(async () => true);
    const { addUser } = await import("./org");
    await addUser({
      account_id: ACCOUNT_ID,
      session_hash: "session-hash",
      name: "acme",
      user: "user@example.com",
    });

    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      session_hash: "session-hash",
      require_second_factor: true,
    });
    expect(withAccountRehomeWriteFenceMock).toHaveBeenCalledWith({
      account_id: USER_ACCOUNT_ID,
      action: "add account to organization",
      fn: expect.any(Function),
    });
  });

  it("requires fresh recent 2FA before org-admin admin grants", async () => {
    const { addAdmin } = await import("./org");
    await addAdmin({
      account_id: ACCOUNT_ID,
      session_hash: "session-hash",
      name: "acme",
      user: "user@example.com",
    });

    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      session_hash: "session-hash",
      require_second_factor: true,
    });
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("SET admin_account_ids"),
      ["acme", USER_ACCOUNT_ID],
    );
    expect(withAccountRehomeWriteFenceMock).toHaveBeenCalledWith({
      account_id: USER_ACCOUNT_ID,
      action: "add account to organization",
      fn: expect.any(Function),
    });
  });

  it("requires fresh recent 2FA before org-admin user removal", async () => {
    const { removeUser } = await import("./org");
    await removeUser({
      account_id: ACCOUNT_ID,
      session_hash: "session-hash",
      name: "acme",
      user: "user@example.com",
    });

    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      session_hash: "session-hash",
      require_second_factor: true,
    });
    expect(withAccountRehomeWriteFenceMock).toHaveBeenCalledWith({
      account_id: USER_ACCOUNT_ID,
      action: "remove account from organization",
      fn: expect.any(Function),
    });
  });
});
