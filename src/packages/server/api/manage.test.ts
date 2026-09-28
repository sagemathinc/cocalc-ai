export {};

import { randomUUID } from "node:crypto";
import { Pool } from "pg";

let queryMock: jest.Mock;
let isValidAccountMock: jest.Mock;
let verifyPasswordMock: jest.Mock;
let ensureAccountSecurityStateReadyMock: jest.Mock;
let isAccountBannedCachedMock: jest.Mock;
let getClusterAccountByIdMock: jest.Mock;
let getClusterAccountApiKeyByKeyIdMock: jest.Mock;
let touchClusterAccountApiKeyDirectoryEntryMock: jest.Mock;
let upsertClusterAccountApiKeyDirectoryEntryMock: jest.Mock;
let deleteClusterAccountApiKeyDirectoryEntryMock: jest.Mock;
let centralLogMock: jest.Mock;
let resolveProjectReferenceMock: jest.Mock;
let getApiKeyAuthorizationStateMock: jest.Mock;

jest.mock("./issuance-sequence", () => ({
  withApiKeyIssuance: async (_pool, _account, mutate) =>
    mutate({ query: (...args) => queryMock(...args) }, "9007199254740993"),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));
jest.mock("./key-authorization-state", () => ({
  getApiKeyAuthorizationState: (...args: any[]) =>
    getApiKeyAuthorizationStateMock(...args),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

jest.mock("@cocalc/server/accounts/is-valid-account", () => ({
  __esModule: true,
  default: (...args: any[]) => isValidAccountMock(...args),
}));

jest.mock("@cocalc/backend/auth/password-hash", () => ({
  __esModule: true,
  default: jest.fn(() => "hash"),
  verifyPassword: (...args: any[]) => verifyPasswordMock(...args),
}));

jest.mock("@cocalc/server/accounts/security-state", () => ({
  ensureAccountSecurityStateReady: (...args: any[]) =>
    ensureAccountSecurityStateReadyMock(...args),
  isAccountBannedCached: (...args: any[]) => isAccountBannedCachedMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  __esModule: true,
  getClusterAccountById: (...args: any[]) => getClusterAccountByIdMock(...args),
  getClusterAccountApiKeyByKeyId: (...args: any[]) =>
    getClusterAccountApiKeyByKeyIdMock(...args),
  touchClusterAccountApiKeyDirectoryEntry: (...args: any[]) =>
    touchClusterAccountApiKeyDirectoryEntryMock(...args),
  upsertClusterAccountApiKeyDirectoryEntry: (...args: any[]) =>
    upsertClusterAccountApiKeyDirectoryEntryMock(...args),
  deleteClusterAccountApiKeyDirectoryEntry: (...args: any[]) =>
    deleteClusterAccountApiKeyDirectoryEntryMock(...args),
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

jest.mock("@cocalc/database/postgres/central-log", () => ({
  __esModule: true,
  default: (...args: any[]) => centralLogMock(...args),
}));

jest.mock("@cocalc/server/conat/project-remote-access", () => ({
  resolveProjectReferenceForMemberAllowRemote: (...args: any[]) =>
    resolveProjectReferenceMock(...args),
}));

describe("manageApiKeys local bay access", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

  async function flushAuditEvents(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  function nonSchemaQueries() {
    return queryMock.mock.calls.filter(([sql]) => {
      const text = `${sql}`;
      return (
        !text.includes("ALTER TABLE accounts ADD COLUMN") &&
        !text.includes("ALTER TABLE api_keys ADD COLUMN") &&
        !text.includes("ALTER TABLE api_keys ALTER COLUMN") &&
        !text.includes("UPDATE api_keys SET scope_revision=1") &&
        !text.includes(
          "CREATE UNIQUE INDEX IF NOT EXISTS api_keys_key_id_unique_idx",
        ) &&
        !text.includes("api_keys_capabilities_gin_idx") &&
        !text.includes("api_keys_allowed_project_ids_gin_idx")
      );
    });
  }

  beforeEach(() => {
    jest.resetModules();
    queryMock = jest.fn(async () => ({ rows: [] }));
    isValidAccountMock = jest.fn(async () => true);
    verifyPasswordMock = jest.fn(() => true);
    ensureAccountSecurityStateReadyMock = jest.fn(async () => undefined);
    isAccountBannedCachedMock = jest.fn(() => false);
    getClusterAccountByIdMock = jest.fn(async () => ({
      account_id: ACCOUNT_ID,
      home_bay_id: "bay-0",
    }));
    getClusterAccountApiKeyByKeyIdMock = jest.fn(async () => null);
    getApiKeyAuthorizationStateMock = jest.fn(async () => null);
    touchClusterAccountApiKeyDirectoryEntryMock = jest.fn(
      async () => undefined,
    );
    upsertClusterAccountApiKeyDirectoryEntryMock = jest.fn(
      async () => undefined,
    );
    deleteClusterAccountApiKeyDirectoryEntryMock = jest.fn(
      async () => undefined,
    );
    centralLogMock = jest.fn(async () => undefined);
    resolveProjectReferenceMock = jest.fn(async () => ({
      users: { [ACCOUNT_ID]: { group: "collaborator" } },
    }));
  });

  it("allows account-wide api key management", async () => {
    const { default: manageApiKeys } = await import("./manage");
    await expect(
      manageApiKeys({
        account_id: ACCOUNT_ID,
        action: "get",
      }),
    ).resolves.toEqual([]);
    expect(nonSchemaQueries()).toHaveLength(1);
  });

  it("creates v2 api keys with random portable key ids", async () => {
    const inserted = {
      id: 17,
      key_id: "random-key-id",
      account_id: ACCOUNT_ID,
      expire: null,
      created: new Date("2026-04-22T00:00:00Z"),
      name: "test key",
      capabilities: ["account:read"],
      allowed_project_ids: [],
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
      capabilities: ["account:read"],
      allowed_project_ids: [],
    });
    const key = result?.[0];
    expect(key?.key_id).toBe("random-key-id");
    expect(key?.secret).toMatch(/^sk-cc-v2\.random-key-id\.[A-Za-z0-9_-]+$/);
    expect(key?.trunc).toMatch(/^sk-cc\.\.\.[A-Za-z0-9_-]{8}$/);
    expect(
      queryMock.mock.calls.some(([sql]) =>
        `${sql}`.includes(
          "UPDATE api_keys SET scope_revision=1 WHERE scope_revision IS NULL",
        ),
      ),
    ).toBe(true);
    expect(
      queryMock.mock.calls.some(([sql]) =>
        `${sql}`.includes("scope,scope_revision,issuance_sequence) VALUES"),
      ),
    ).toBe(true);
    expect(centralLogMock).toHaveBeenCalledWith({
      event: "api_key_created",
      value: {
        account_id: ACCOUNT_ID,
        api_key_id: 17,
        key_id: "random-key-id",
        source: "account-api-key-management",
      },
    });
    const update = nonSchemaQueries().find(([sql]) =>
      `${sql}`.includes("UPDATE api_keys SET trunc=$1,hash=$2"),
    );
    expect(update).toBeTruthy();
    const insert = queryMock.mock.calls.find(([sql]) =>
      `${sql}`.includes("INSERT INTO api_keys"),
    );
    expect(insert?.[1][7]).toBe("9007199254740993");
  });

  it("requires full collaborator membership for a versioned viewer grant", async () => {
    resolveProjectReferenceMock.mockResolvedValueOnce({
      users: { [ACCOUNT_ID]: { group: "viewer" } },
    });
    const { default: manageApiKeys } = await import("./manage");
    await expect(
      manageApiKeys({
        account_id: ACCOUNT_ID,
        action: "create",
        name: "viewer key",
        scope: {
          version: 1,
          account: [],
          projects: [
            {
              project_id: PROJECT_ID,
              capabilities: ["file:read"],
              viewer_read_roots: ["."],
            },
          ],
        },
      }),
    ).rejects.toThrow("full collaborator access required");
    expect(resolveProjectReferenceMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(
      queryMock.mock.calls.some(([sql]) =>
        `${sql}`.includes("INSERT INTO api_keys"),
      ),
    ).toBe(false);
  });

  it("audits deleted api keys without exposing the secret", async () => {
    queryMock = jest.fn(async (sql) => {
      const text = `${sql}`;
      if (text.includes("SELECT id,key_id,account_id")) {
        return {
          rows: [
            {
              id: 17,
              key_id: "random-key-id",
              account_id: ACCOUNT_ID,
              capabilities: ["account:read"],
              allowed_project_ids: [],
            },
          ],
        };
      }
      return { rows: [], rowCount: 1 };
    });
    const { default: manageApiKeys } = await import("./manage");
    await manageApiKeys({
      account_id: ACCOUNT_ID,
      action: "delete",
      id: 17,
    });
    expect(centralLogMock).toHaveBeenCalledWith({
      event: "api_key_deleted",
      value: {
        account_id: ACCOUNT_ID,
        api_key_id: 17,
        key_id: "random-key-id",
        source: "account-api-key-management",
      },
    });
  });

  it.each([
    { expire: new Date("2027-09-25T00:00:00Z") },
    { scope: { version: 1, account: ["account:read"], projects: [] } },
  ])(
    "does not let manual editing renew a managed turn key: %j",
    async (edit) => {
      queryMock = jest.fn(async (sql) => {
        const text = `${sql}`;
        if (text.includes("SELECT id,key_id,account_id")) {
          return {
            rows: [
              {
                id: 17,
                key_id: "managed-key",
                account_id: ACCOUNT_ID,
                name: "CoCalc connector turn",
                expire: new Date("2026-09-25T00:00:00Z"),
                capabilities: [],
                allowed_project_ids: [],
              },
            ],
          };
        }
        return { rows: [] };
      });
      const { default: manageApiKeys } = await import("./manage");
      await expect(
        manageApiKeys({
          account_id: ACCOUNT_ID,
          action: "edit",
          id: 17,
          ...edit,
        }),
      ).rejects.toThrow("managed by a connector");
      expect(
        queryMock.mock.calls.find(([sql]) =>
          `${sql}`.includes("UPDATE api_keys SET expire="),
        )?.[0],
      ).toContain("NOT EXISTS");
      expect(
        upsertClusterAccountApiKeyDirectoryEntryMock,
      ).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "scope",
      { scope: { version: 1, account: ["account:read"], projects: [] } },
      true,
    ],
    ["legacy scope", { capabilities: ["account:read"] }, true],
    ["name", { name: "renamed" }, false],
    ["expiry", { expire: new Date("2027-01-01") }, false],
  ])(
    "allocates fresh delegation only for explicit %s edits",
    async (_name, edit, regrant) => {
      queryMock = jest.fn(async (sql) => {
        if (`${sql}`.includes("SELECT id,key_id,account_id")) {
          return {
            rows: [
              {
                id: 17,
                key_id: "manual-key",
                account_id: ACCOUNT_ID,
                name: "old",
                capabilities: ["account:read"],
                allowed_project_ids: [],
              },
            ],
          };
        }
        if (`${sql}`.includes("UPDATE api_keys SET expire=")) {
          return { rows: [{ scope_revision: 2 }] };
        }
        if (`${sql}`.includes("SELECT hash FROM api_keys")) {
          return { rows: [{ hash: "hash" }] };
        }
        return { rows: [] };
      });
      const { default: manageApiKeys } = await import("./manage");
      await manageApiKeys({
        account_id: ACCOUNT_ID,
        action: "edit",
        id: 17,
        ...edit,
      });
      const update = queryMock.mock.calls.find(([sql]) =>
        `${sql}`.includes("UPDATE api_keys SET expire="),
      );
      expect(update?.[0]).toContain(
        "issuance_sequence=COALESCE($9::BIGINT,issuance_sequence)",
      );
      expect(update?.[1][8]).toBe(regrant ? "9007199254740993" : null);
      expect(upsertClusterAccountApiKeyDirectoryEntryMock).toHaveBeenCalledWith(
        expect.objectContaining({ scope_revision: 2 }),
      );
    },
  );

  it("rejects api key creation without explicit capabilities", async () => {
    const { default: manageApiKeys } = await import("./manage");
    await expect(
      manageApiKeys({
        account_id: ACCOUNT_ID,
        action: "create",
        name: "test key",
      }),
    ).rejects.toThrow("API keys must have at least one explicit capability");
  });

  it("looks up v2 api keys by key_id without decoding a local id", async () => {
    const secret = "sk-cocalc-v2.key-id-123.secret-part";
    queryMock = jest.fn(async (sql) => {
      if (`${sql}`.includes("WHERE key_id=$1")) {
        return {
          rows: [
            {
              id: 9,
              key_id: "key-id-123",
              account_id: ACCOUNT_ID,
              hash: "hash",
              expire: null,
              capabilities: ["account:read"],
              allowed_project_ids: [],
            },
          ],
        };
      }
      return { rows: [] };
    });
    const { getAccountWithApiKey } = await import("./manage");
    await expect(getAccountWithApiKey(secret)).resolves.toEqual({
      account_id: ACCOUNT_ID,
      api_key_id: 9,
      key_id: "key-id-123",
      auth_method: "api_key",
      capabilities: ["account:read"],
      allowed_project_ids: [],
      scope: { version: 1, account: ["account:read"], projects: [] },
      scope_revision: 1,
    });
    expect(touchClusterAccountApiKeyDirectoryEntryMock).toHaveBeenCalledWith({
      key_id: "key-id-123",
    });
    expect(upsertClusterAccountApiKeyDirectoryEntryMock).not.toHaveBeenCalled();
    await flushAuditEvents();
    expect(centralLogMock).toHaveBeenCalledWith({
      event: "api_key_used",
      value: {
        account_id: ACCOUNT_ID,
        api_key_id: 9,
        key_id: "key-id-123",
        source: "api-key-auth-local",
      },
    });
    expect(nonSchemaQueries()[0]).toEqual([
      "SELECT id,key_id,account_id,hash,expire,capabilities,allowed_project_ids,scope,scope_revision FROM api_keys WHERE key_id=$1",
      ["key-id-123"],
    ]);
  });

  it("does not cache the authoritative key lookup during revalidation", async () => {
    const { default: getPool } = await import("@cocalc/database/pool");
    const { getAccountWithApiKey } = await import("./manage");
    await getAccountWithApiKey("sk-cc-v2.random-key-id.secret", {
      recordActivity: false,
    });
    expect(getPool).not.toHaveBeenCalledWith("medium");
    expect(
      queryMock.mock.calls.some(([sql]) =>
        `${sql}`.includes("FROM api_keys WHERE key_id=$1"),
      ),
    ).toBe(true);
  });

  it("revalidates a local key without updating activity or writing a use audit", async () => {
    queryMock = jest.fn(async (sql) =>
      `${sql}`.includes("WHERE key_id=$1")
        ? {
            rows: [
              {
                id: 9,
                key_id: "key-id-123",
                account_id: ACCOUNT_ID,
                hash: "hash",
                scope_revision: 1,
                capabilities: ["account:read"],
                allowed_project_ids: [],
              },
            ],
          }
        : { rows: [] },
    );
    const { getAccountWithApiKey } = await import("./manage");
    await expect(
      getAccountWithApiKey("sk-cocalc-v2.key-id-123.secret-part", {
        recordActivity: false,
      }),
    ).resolves.toMatchObject({ account_id: ACCOUNT_ID, key_id: "key-id-123" });
    expect(
      queryMock.mock.calls.some(([sql]) =>
        `${sql}`.includes("UPDATE api_keys SET last_active="),
      ),
    ).toBe(false);
    expect(touchClusterAccountApiKeyDirectoryEntryMock).not.toHaveBeenCalled();
    await flushAuditEvents();
    expect(centralLogMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "api_key_used" }),
    );
  });

  it("keeps mixed per-project grants separate when authenticating a versioned key", async () => {
    const b = "22222222-2222-4222-8222-222222222222";
    const c = "33333333-3333-4333-8333-333333333333";
    const scope = {
      version: 1,
      account: ["project:list"],
      projects: [
        { project_id: b, capabilities: ["project:exec"] },
        {
          project_id: c,
          capabilities: ["file:read"],
          viewer_read_roots: ["docs"],
        },
      ],
    };
    queryMock = jest.fn(async (sql) => {
      if (`${sql}`.includes("WHERE key_id=$1")) {
        return {
          rows: [
            {
              id: 12,
              key_id: "mixed-key",
              account_id: ACCOUNT_ID,
              hash: "hash",
              expire: null,
              capabilities: [],
              allowed_project_ids: [],
              scope,
              scope_revision: 4,
            },
          ],
        };
      }
      return { rows: [] };
    });
    const { getAccountWithApiKey } = await import("./manage");
    const principal = await getAccountWithApiKey(
      "sk-cocalc-v2.mixed-key.secret-part",
    );
    expect(principal?.scope).toEqual(scope);
    expect(principal?.scope_revision).toBe(4);
    expect(principal?.capabilities).toEqual([]);
    expect(principal?.allowed_project_ids).toEqual([]);
    expect(getClusterAccountApiKeyByKeyIdMock).not.toHaveBeenCalled();
  });

  it("denies an invalid local scope revision without directory fallback", async () => {
    queryMock = jest.fn(async (sql) => {
      if (`${sql}`.includes("WHERE key_id=$1")) {
        return {
          rows: [
            {
              id: 12,
              key_id: "bad-revision",
              account_id: ACCOUNT_ID,
              hash: "hash",
              expire: null,
              capabilities: [],
              allowed_project_ids: [],
              scope: { version: 1, account: ["project:list"], projects: [] },
              scope_revision: 0,
            },
          ],
        };
      }
      return { rows: [] };
    });
    const { getAccountWithApiKey } = await import("./manage");
    await expect(
      getAccountWithApiKey("sk-cocalc-v2.bad-revision.secret-part"),
    ).resolves.toBeUndefined();
    expect(getClusterAccountApiKeyByKeyIdMock).not.toHaveBeenCalled();
  });

  it("falls back to the cluster api key directory when the local bay lacks the key row", async () => {
    const secret = "sk-cocalc-v2.key-id-remote.secret-part";
    getClusterAccountApiKeyByKeyIdMock = jest.fn(async () => ({
      key_id: "key-id-remote",
      account_id: ACCOUNT_ID,
      home_bay_id: "bay-1",
      hash: "hash",
      capabilities: ["project:exec"],
      allowed_project_ids: ["22222222-2222-4222-8222-222222222222"],
      expire: null,
      last_active: null,
    }));
    getClusterAccountByIdMock = jest.fn(async () => ({
      account_id: ACCOUNT_ID,
      home_bay_id: "bay-1",
    }));
    getApiKeyAuthorizationStateMock = jest.fn(async () => ({
      hash: "hash",
      scope_revision: 1,
      scope: {
        version: 1,
        account: [],
        projects: [{ project_id: PROJECT_ID, capabilities: ["project:exec"] }],
      },
    }));
    const { getAccountWithApiKey } = await import("./manage");
    await expect(getAccountWithApiKey(secret)).resolves.toEqual({
      account_id: ACCOUNT_ID,
      api_key_id: -1,
      key_id: "key-id-remote",
      auth_method: "api_key",
      capabilities: ["project:exec"],
      allowed_project_ids: ["22222222-2222-4222-8222-222222222222"],
      scope: {
        version: 1,
        account: [],
        projects: [
          {
            project_id: "22222222-2222-4222-8222-222222222222",
            capabilities: ["project:exec"],
          },
        ],
      },
      scope_revision: 1,
    });
    expect(getClusterAccountApiKeyByKeyIdMock).toHaveBeenCalledWith(
      "key-id-remote",
    );
    expect(touchClusterAccountApiKeyDirectoryEntryMock).toHaveBeenCalledWith({
      key_id: "key-id-remote",
    });
    expect(getApiKeyAuthorizationStateMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      key_id: "key-id-remote",
    });
    await flushAuditEvents();
    expect(centralLogMock).toHaveBeenCalledWith({
      event: "api_key_used",
      value: {
        account_id: ACCOUNT_ID,
        api_key_id: -1,
        key_id: "key-id-remote",
        source: "api-key-auth-directory",
      },
    });
  });

  it("does not revoke a renewed key based on an expired directory snapshot", async () => {
    const secret = "sk-cocalc-v2.key-id-remote.secret-part";
    const renewedExpiry = Date.now() + 60_000;
    let directoryExpiry = Date.now() - 1;
    const entry = {
      key_id: "key-id-remote",
      account_id: ACCOUNT_ID,
      home_bay_id: "bay-1",
      hash: "hash",
      capabilities: ["project:exec"],
      allowed_project_ids: [PROJECT_ID],
      scope_revision: 1,
    };
    getClusterAccountApiKeyByKeyIdMock.mockImplementation(async () => ({
      ...entry,
      expire: directoryExpiry,
    }));
    getApiKeyAuthorizationStateMock.mockResolvedValue({
      hash: "hash",
      scope_revision: 1,
      expire_ms: renewedExpiry,
      scope: {
        version: 1,
        account: [],
        projects: [{ project_id: PROJECT_ID, capabilities: ["project:exec"] }],
      },
    });
    // Renewal has already committed at home; replication catches up after the
    // authentication read captured its stale expiry.
    verifyPasswordMock.mockImplementationOnce(() => {
      directoryExpiry = renewedExpiry;
      return true;
    });
    const { getAccountWithApiKey } = await import("./manage");
    await expect(getAccountWithApiKey(secret)).resolves.toBeUndefined();
    expect(deleteClusterAccountApiKeyDirectoryEntryMock).not.toHaveBeenCalled();
    expect(touchClusterAccountApiKeyDirectoryEntryMock).not.toHaveBeenCalled();
    await expect(getAccountWithApiKey(secret)).resolves.toMatchObject({
      account_id: ACCOUNT_ID,
      key_id: entry.key_id,
      expire_ms: renewedExpiry,
    });
    expect(deleteClusterAccountApiKeyDirectoryEntryMock).not.toHaveBeenCalled();
  });

  it("does not delete a local key renewed after authentication read its expiry", async () => {
    const secret = "sk-cocalc-v2.key-id-local.secret-part";
    const renewedExpiry = new Date(Date.now() + 60_000);
    let expire = new Date(Date.now() - 1);
    const entry = {
      id: 9,
      key_id: "key-id-local",
      account_id: ACCOUNT_ID,
      hash: "hash",
      capabilities: ["project:exec"],
      allowed_project_ids: [PROJECT_ID],
      scope_revision: 1,
    };
    queryMock.mockImplementation(async (sql) => {
      if (`${sql}`.startsWith("SELECT id,key_id,account_id")) {
        return { rows: [{ ...entry, expire }] };
      }
      return { rows: [], rowCount: 1 };
    });
    verifyPasswordMock.mockImplementationOnce(() => {
      expire = renewedExpiry;
      return true;
    });
    const { getAccountWithApiKey } = await import("./manage");
    await expect(getAccountWithApiKey(secret)).resolves.toBeUndefined();
    expect(
      queryMock.mock.calls.some(([sql]) =>
        `${sql}`.includes("DELETE FROM api_keys"),
      ),
    ).toBe(false);
    expect(deleteClusterAccountApiKeyDirectoryEntryMock).not.toHaveBeenCalled();
    await expect(getAccountWithApiKey(secret)).resolves.toMatchObject({
      account_id: ACCOUNT_ID,
      key_id: entry.key_id,
      expire_ms: renewedExpiry.valueOf(),
    });
    expect(getClusterAccountApiKeyByKeyIdMock).not.toHaveBeenCalled();
  });

  it.each([
    ["deleted", null],
    ["narrowed", { hash: "hash", scope_revision: 2 }],
    ["replaced", { hash: "new-hash", scope_revision: 1 }],
  ])(
    "rejects a stale directory entry after the home key is %s",
    async (_reason, state) => {
      getClusterAccountByIdMock = jest.fn(async () => ({
        account_id: ACCOUNT_ID,
        home_bay_id: "bay-1",
      }));
      getClusterAccountApiKeyByKeyIdMock = jest.fn(async () => ({
        key_id: "key-id-remote",
        account_id: ACCOUNT_ID,
        home_bay_id: "bay-1",
        hash: "hash",
        capabilities: ["project:exec"],
        allowed_project_ids: [PROJECT_ID],
        expire: null,
      }));
      getApiKeyAuthorizationStateMock.mockResolvedValue(state);
      const { getAccountWithApiKey } = await import("./manage");
      await expect(
        getAccountWithApiKey("sk-cocalc-v2.key-id-remote.secret-part"),
      ).resolves.toBeUndefined();
      expect(
        touchClusterAccountApiKeyDirectoryEntryMock,
      ).not.toHaveBeenCalled();
    },
  );

  it("fails closed when the account home is unavailable", async () => {
    getClusterAccountByIdMock = jest.fn(async () => ({
      account_id: ACCOUNT_ID,
      home_bay_id: "bay-1",
    }));
    getClusterAccountApiKeyByKeyIdMock = jest.fn(async () => ({
      key_id: "key-id-remote",
      account_id: ACCOUNT_ID,
      home_bay_id: "bay-1",
      hash: "hash",
      capabilities: ["project:exec"],
      allowed_project_ids: [PROJECT_ID],
      expire: null,
    }));
    getApiKeyAuthorizationStateMock.mockRejectedValue(
      new Error("home unavailable"),
    );
    const { getAccountWithApiKey } = await import("./manage");
    await expect(
      getAccountWithApiKey("sk-cocalc-v2.key-id-remote.secret-part"),
    ).rejects.toThrow("home unavailable");
    expect(touchClusterAccountApiKeyDirectoryEntryMock).not.toHaveBeenCalled();
  });

  it("does not trust a stale local row after account-home migration", async () => {
    getClusterAccountByIdMock = jest.fn(async () => ({
      account_id: ACCOUNT_ID,
      home_bay_id: "bay-1",
    }));
    queryMock = jest.fn(async (sql) => {
      if (`${sql}`.includes("WHERE key_id=$1")) {
        return {
          rows: [
            {
              id: 9,
              key_id: "key-id-remote",
              account_id: ACCOUNT_ID,
              hash: "old-hash",
              scope_revision: 1,
              capabilities: ["project:exec"],
              allowed_project_ids: [PROJECT_ID],
            },
          ],
        };
      }
      return { rows: [] };
    });
    const { getAccountWithApiKey } = await import("./manage");
    await expect(
      getAccountWithApiKey("sk-cocalc-v2.key-id-remote.secret-part"),
    ).resolves.toBeUndefined();
    expect(getClusterAccountApiKeyByKeyIdMock).toHaveBeenCalledWith(
      "key-id-remote",
    );
    expect(touchClusterAccountApiKeyDirectoryEntryMock).not.toHaveBeenCalled();
  });

  it("rejects local api keys for accounts banned in the replicated security cache", async () => {
    isAccountBannedCachedMock = jest.fn(() => true);
    const secret = "sk-cocalc-v2.key-id-123.secret-part";
    queryMock = jest.fn(async (sql) => {
      if (`${sql}`.includes("WHERE key_id=$1")) {
        return {
          rows: [
            {
              id: 9,
              key_id: "key-id-123",
              account_id: ACCOUNT_ID,
              hash: "hash",
              expire: null,
              capabilities: ["account:read"],
              allowed_project_ids: [],
            },
          ],
        };
      }
      return { rows: [] };
    });
    const { getAccountWithApiKey } = await import("./manage");
    await expect(getAccountWithApiKey(secret)).resolves.toBeUndefined();
    expect(ensureAccountSecurityStateReadyMock).toHaveBeenCalled();
    expect(isAccountBannedCachedMock).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(getClusterAccountApiKeyByKeyIdMock).not.toHaveBeenCalled();
    await flushAuditEvents();
    expect(centralLogMock).toHaveBeenCalledWith({
      event: "api_key_denied",
      value: {
        account_id: ACCOUNT_ID,
        api_key_id: 9,
        key_id: "key-id-123",
        source: "api-key-auth-local",
        reason: "account is banned",
        code: "api_key_account_banned",
      },
    });
  });

  it("rejects directory api keys for accounts banned in the replicated security cache", async () => {
    isAccountBannedCachedMock = jest.fn(() => true);
    const secret = "sk-cocalc-v2.key-id-remote.secret-part";
    getClusterAccountApiKeyByKeyIdMock = jest.fn(async () => ({
      key_id: "key-id-remote",
      account_id: ACCOUNT_ID,
      home_bay_id: "bay-1",
      hash: "hash",
      capabilities: ["project:exec"],
      allowed_project_ids: ["22222222-2222-4222-8222-222222222222"],
      expire: null,
      last_active: null,
    }));
    getClusterAccountByIdMock = jest.fn(async () => ({
      account_id: ACCOUNT_ID,
      home_bay_id: "bay-1",
      banned: false,
    }));
    const { getAccountWithApiKey } = await import("./manage");
    await expect(getAccountWithApiKey(secret)).resolves.toBeUndefined();
    expect(ensureAccountSecurityStateReadyMock).toHaveBeenCalled();
    expect(isAccountBannedCachedMock).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(touchClusterAccountApiKeyDirectoryEntryMock).not.toHaveBeenCalled();
    await flushAuditEvents();
    expect(centralLogMock).toHaveBeenCalledWith({
      event: "api_key_denied",
      value: {
        account_id: ACCOUNT_ID,
        key_id: "key-id-remote",
        source: "api-key-auth-directory",
        reason: "account is banned",
        code: "api_key_account_banned",
      },
    });
  });

  it("rejects pre-v2 api key formats without lookup", async () => {
    const { getAccountWithApiKey } = await import("./manage");
    await expect(
      getAccountWithApiKey("sk_legacy-account-key"),
    ).resolves.toBeUndefined();
    await expect(
      getAccountWithApiKey("sk-oldintegerid000001"),
    ).resolves.toBeUndefined();
    await flushAuditEvents();
    expect(centralLogMock).toHaveBeenCalledWith({
      event: "api_key_denied",
      value: {
        source: "api-key-auth",
        reason: "invalid API key format",
        code: "api_key_invalid_format",
      },
    });
    expect(nonSchemaQueries()).toHaveLength(0);
  });

  it("audits api key secret mismatches by key id only", async () => {
    verifyPasswordMock = jest.fn(() => false);
    const secret = "sk-cocalc-v2.key-id-123.secret-part";
    queryMock = jest.fn(async (sql) => {
      if (`${sql}`.includes("WHERE key_id=$1")) {
        return {
          rows: [
            {
              id: 9,
              key_id: "key-id-123",
              account_id: ACCOUNT_ID,
              hash: "hash",
              expire: null,
              capabilities: ["account:read"],
              allowed_project_ids: [],
            },
          ],
        };
      }
      return { rows: [] };
    });
    const { getAccountWithApiKey } = await import("./manage");
    await expect(getAccountWithApiKey(secret)).resolves.toBeUndefined();
    expect(getClusterAccountApiKeyByKeyIdMock).not.toHaveBeenCalled();
    await flushAuditEvents();
    expect(centralLogMock).toHaveBeenCalledWith({
      event: "api_key_denied",
      value: {
        account_id: ACCOUNT_ID,
        api_key_id: 9,
        key_id: "key-id-123",
        source: "api-key-auth-local",
        reason: "API key secret does not match",
        code: "api_key_secret_mismatch",
      },
    });
  });
});

const migrationDatabase = process.env.COCALC_TEST_MANAGED_POSTGRES_DB;
(migrationDatabase ? describe : describe.skip)(
  "historical API key schema upgrade",
  () => {
    let pool: Pool;
    let schema: string;
    beforeEach(async () => {
      if (!process.env.PGHOST?.startsWith("/"))
        throw Error("local PostgreSQL socket required");
      schema = `key_upgrade_${randomUUID().replaceAll("-", "")}`;
      const admin = new Pool({ database: migrationDatabase });
      try {
        await admin.query(`CREATE SCHEMA ${schema}`);
      } finally {
        await admin.end();
      }
      pool = new Pool({
        database: migrationDatabase,
        options: `-c search_path=${schema} -c statement_timeout=15000`,
      });
      await pool.query("CREATE TABLE accounts(account_id UUID PRIMARY KEY)");
      await pool.query(
        "CREATE TABLE api_keys(id INTEGER PRIMARY KEY, account_id UUID, hash TEXT, expire TIMESTAMPTZ)",
      );
      queryMock = jest.fn((sql, args) => pool.query(sql, args));
      jest.resetModules();
    });
    afterEach(async () => {
      if (!pool) return;
      try {
        await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await pool.end();
      }
    });
    it.each(["pre-scope", "nullable-revision"])(
      "upgrades %s rows without changing stored credentials or grants",
      async (version) => {
        const owner = randomUUID();
        const project = randomUUID();
        await pool.query("INSERT INTO accounts VALUES($1)", [owner]);
        await pool.query(
          "INSERT INTO api_keys VALUES(1,$1,'synthetic-hash',NULL),(2,$1,'second-hash',now()+interval '1 day')",
          [owner],
        );
        const before = (
          await pool.query(
            "SELECT id,account_id,hash,expire FROM api_keys ORDER BY id",
          )
        ).rows;
        if (version === "nullable-revision") {
          await pool.query(
            "ALTER TABLE api_keys ADD COLUMN scope_revision INTEGER, ADD COLUMN capabilities TEXT[] NOT NULL DEFAULT '{}', ADD COLUMN allowed_project_ids UUID[] NOT NULL DEFAULT '{}', ADD COLUMN scope JSONB",
          );
          await pool.query(
            "UPDATE api_keys SET capabilities=ARRAY['file:read'],allowed_project_ids=ARRAY[$1::UUID] WHERE id=1",
            [project],
          );
          await pool.query(
            "UPDATE api_keys SET scope_revision=7,scope=$1::JSONB WHERE id=2",
            [
              JSON.stringify({
                version: 1,
                account: ["project:list"],
                projects: [],
              }),
            ],
          );
        }
        const { ensureApiKeysV2Schema } = await import("./manage");
        await ensureApiKeysV2Schema();
        expect(
          (
            await pool.query(
              "SELECT id,account_id,hash,expire FROM api_keys ORDER BY id",
            )
          ).rows,
        ).toEqual(before);
        const rows = (await pool.query("SELECT * FROM api_keys ORDER BY id"))
          .rows;
        expect(rows.map((row) => row.scope_revision)).toEqual(
          version === "nullable-revision" ? [1, 7] : [1, 1],
        );
        expect(rows[0].capabilities).toEqual(
          version === "nullable-revision" ? ["file:read"] : [],
        );
        expect(rows[0].allowed_project_ids).toEqual(
          version === "nullable-revision" ? [project] : [],
        );
        expect(rows[0].scope).toBeNull();
        expect(rows[1].scope).toEqual(
          version === "nullable-revision"
            ? { version: 1, account: ["project:list"], projects: [] }
            : null,
        );
        await pool.query(
          "INSERT INTO api_keys(id,account_id,hash) VALUES(3,$1,'new-hash')",
          [owner],
        );
        expect(
          (await pool.query("SELECT scope_revision FROM api_keys WHERE id=3"))
            .rows[0].scope_revision,
        ).toBe(1);
        await expect(
          pool.query("UPDATE api_keys SET scope_revision=NULL WHERE id=1"),
        ).rejects.toMatchObject({ code: "23502" });
        // Replay the DDL through a fresh module, as another process would after restart.
        jest.resetModules();
        await (await import("./manage")).ensureApiKeysV2Schema();
        expect(
          (await pool.query("SELECT * FROM api_keys WHERE id<3 ORDER BY id"))
            .rows,
        ).toEqual(rows);
      },
    );
  },
);
