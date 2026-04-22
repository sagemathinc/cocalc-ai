export {};

import base62 from "base62/lib/ascii";

let queryMock: jest.Mock;
let isValidAccountMock: jest.Mock;
let assertProjectCollaboratorAccessAllowRemoteMock: jest.Mock;
let getLocalProjectCollaboratorAccessStatusMock: jest.Mock;
let verifyPasswordMock: jest.Mock;
let isBannedMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

jest.mock("@cocalc/server/accounts/is-valid-account", () => ({
  __esModule: true,
  default: (...args: any[]) => isValidAccountMock(...args),
}));

jest.mock("@cocalc/server/conat/project-remote-access", () => ({
  __esModule: true,
  assertProjectCollaboratorAccessAllowRemote: (...args: any[]) =>
    assertProjectCollaboratorAccessAllowRemoteMock(...args),
}));

jest.mock("@cocalc/server/conat/project-local-access", () => ({
  __esModule: true,
  getLocalProjectCollaboratorAccessStatus: (...args: any[]) =>
    getLocalProjectCollaboratorAccessStatusMock(...args),
}));

jest.mock("@cocalc/backend/auth/password-hash", () => ({
  __esModule: true,
  default: jest.fn(() => "hash"),
  verifyPassword: (...args: any[]) => verifyPasswordMock(...args),
}));

jest.mock("@cocalc/server/accounts/is-banned", () => ({
  __esModule: true,
  default: (...args: any[]) => isBannedMock(...args),
}));

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  getLogger: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

describe("manageApiKeys local bay access", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

  function nonSchemaQueries() {
    return queryMock.mock.calls.filter(([sql]) => {
      const text = `${sql}`;
      return (
        !text.includes("ALTER TABLE api_keys ADD COLUMN") &&
        !text.includes(
          "CREATE UNIQUE INDEX IF NOT EXISTS api_keys_key_id_unique_idx",
        )
      );
    });
  }

  beforeEach(() => {
    jest.resetModules();
    queryMock = jest.fn(async () => ({ rows: [] }));
    isValidAccountMock = jest.fn(async () => true);
    assertProjectCollaboratorAccessAllowRemoteMock = jest.fn(
      async () => undefined,
    );
    getLocalProjectCollaboratorAccessStatusMock = jest.fn(
      async () => "local-collaborator",
    );
    verifyPasswordMock = jest.fn(() => true);
    isBannedMock = jest.fn(async () => false);
  });

  it("allows project-scoped api key management for remote collaborators", async () => {
    const { default: manageApiKeys } = await import("./manage");
    await expect(
      manageApiKeys({
        account_id: ACCOUNT_ID,
        action: "get",
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual([]);
    expect(assertProjectCollaboratorAccessAllowRemoteMock).toHaveBeenCalledWith(
      {
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      },
    );
    expect(nonSchemaQueries()).toHaveLength(1);
  });

  it("allows account-wide api key management without project bay checks", async () => {
    const { default: manageApiKeys } = await import("./manage");
    await expect(
      manageApiKeys({
        account_id: ACCOUNT_ID,
        action: "get",
      }),
    ).resolves.toEqual([]);
    expect(
      assertProjectCollaboratorAccessAllowRemoteMock,
    ).not.toHaveBeenCalled();
    expect(nonSchemaQueries()).toHaveLength(1);
  });

  it("allows project-scoped api key management for collaborators", async () => {
    const { default: manageApiKeys } = await import("./manage");
    await expect(
      manageApiKeys({
        account_id: ACCOUNT_ID,
        action: "get",
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual([]);
    expect(assertProjectCollaboratorAccessAllowRemoteMock).toHaveBeenCalledWith(
      {
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      },
    );
    expect(nonSchemaQueries()).toHaveLength(1);
  });

  it("rejects project api keys on the wrong bay without deleting them", async () => {
    const secret = `sk-test${base62.encode(1).padStart(6, "0")}`;
    queryMock = jest.fn(async (sql) => {
      if (`${sql}`.includes("SELECT id,account_id,project_id,hash,expire")) {
        return {
          rows: [
            {
              id: 1,
              account_id: ACCOUNT_ID,
              project_id: PROJECT_ID,
              hash: "hash",
              expire: null,
            },
          ],
        };
      }
      return { rows: [] };
    });
    getLocalProjectCollaboratorAccessStatusMock = jest.fn(
      async () => "wrong-bay",
    );
    const { getAccountWithApiKey } = await import("./manage");
    await expect(getAccountWithApiKey(secret)).resolves.toBeUndefined();
    expect(getLocalProjectCollaboratorAccessStatusMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(nonSchemaQueries()).toHaveLength(1);
  });

  it("deletes stale project api keys when creator is no longer a collaborator", async () => {
    const secret = `sk-test${base62.encode(7).padStart(6, "0")}`;
    queryMock = jest.fn(async (sql) => {
      if (`${sql}`.includes("SELECT id,account_id,project_id,hash,expire")) {
        return {
          rows: [
            {
              id: 7,
              account_id: ACCOUNT_ID,
              project_id: PROJECT_ID,
              hash: "hash",
              expire: null,
            },
          ],
        };
      }
      return { rows: [], rowCount: 1 };
    });
    getLocalProjectCollaboratorAccessStatusMock = jest.fn(
      async () => "not-collaborator",
    );
    const { getAccountWithApiKey } = await import("./manage");
    await expect(getAccountWithApiKey(secret)).resolves.toBeUndefined();
    expect(nonSchemaQueries()[1]).toEqual([
      "DELETE FROM api_keys WHERE project_id=$1 AND id=$2",
      [PROJECT_ID, 7],
    ]);
  });

  it("creates v2 api keys with random portable key ids", async () => {
    const inserted = {
      id: 17,
      key_id: "random-key-id",
      account_id: ACCOUNT_ID,
      expire: null,
      created: new Date("2026-04-22T00:00:00Z"),
      name: "test key",
      last_active: null,
    };
    queryMock = jest.fn(async (sql) => {
      const text = `${sql}`;
      if (text.includes("SELECT COUNT(*) AS count")) {
        return { rows: [{ count: 0 }] };
      }
      if (text.includes("INSERT INTO api_keys")) {
        return { rows: [inserted] };
      }
      return { rows: [], rowCount: 1 };
    });
    const { default: manageApiKeys } = await import("./manage");
    const result = await manageApiKeys({
      account_id: ACCOUNT_ID,
      action: "create",
      name: "test key",
    });
    const key = result?.[0];
    expect(key?.key_id).toBe("random-key-id");
    expect(key?.secret).toMatch(
      /^sk-cocalc-v2\.random-key-id\.[A-Za-z0-9_-]+$/,
    );
    expect(key?.trunc).toMatch(/^sk-co\.\.\.[A-Za-z0-9_-]{8}$/);
    const update = nonSchemaQueries().find(([sql]) =>
      `${sql}`.includes("UPDATE api_keys SET trunc=$1,hash=$2"),
    );
    expect(update).toBeTruthy();
  });

  it("looks up v2 api keys by key_id without decoding a local id", async () => {
    const secret = "sk-cocalc-v2.key-id-123.secret-part";
    queryMock = jest.fn(async (sql) => {
      if (`${sql}`.includes("WHERE key_id=$1")) {
        return {
          rows: [
            {
              id: 9,
              account_id: ACCOUNT_ID,
              project_id: null,
              hash: "hash",
              expire: null,
            },
          ],
        };
      }
      return { rows: [] };
    });
    const { getAccountWithApiKey } = await import("./manage");
    await expect(getAccountWithApiKey(secret)).resolves.toEqual({
      account_id: ACCOUNT_ID,
    });
    expect(nonSchemaQueries()[0]).toEqual([
      "SELECT id,account_id,project_id,hash,expire FROM api_keys WHERE key_id=$1",
      ["key-id-123"],
    ]);
  });
});
