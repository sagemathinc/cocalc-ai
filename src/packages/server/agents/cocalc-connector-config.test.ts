/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

export {};

const accountId = "00000000-0000-4000-8000-000000000001";
const agentId = "00000000-0000-4000-8000-000000000002";
const projectId = "00000000-0000-4000-8000-000000000003";
const queryMock = jest.fn();
const homeMock = jest.fn();
const freshAuthMock = jest.fn();
const identityMock = jest.fn();
const projectsMock = jest.fn();
const sourceMock = jest.fn();
const directoryDeleteMock = jest.fn();
const releaseMock = jest.fn();
let activeKeyIds: string[] = [];

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    query: (...args: any[]) => queryMock(...args),
    connect: async () => ({ query: queryMock, release: releaseMock }),
  })),
}));
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  deleteClusterAccountApiKeyDirectoryEntry: (...args: any[]) =>
    directoryDeleteMock(...args),
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: (...args: any[]) => homeMock(...args),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: jest.fn(() => "bay-0"),
}));
jest.mock("@cocalc/server/conat/api/dangerous-session-auth", () => ({
  requireDangerousSessionAuth: (...args: any[]) => freshAuthMock(...args),
}));
jest.mock("@cocalc/server/api/scope-project-access", () => ({
  assertScopeProjectsCollaborator: (...args: any[]) => projectsMock(...args),
  assertProjectFullCollaborator: (...args: any[]) => sourceMock(...args),
}));
jest.mock("./api", () => ({
  getIdentity: (...args: any[]) => identityMock(...args),
}));

describe("CoCalc connector configuration", () => {
  const locator = {
    account_id: accountId,
    agent_id: agentId,
    source_project_id: projectId,
  };
  const scope = {
    version: 1 as const,
    account: ["project:list" as const],
    projects: [],
  };
  const saved = {
    config_id: "00000000-0000-4000-8000-000000000004",
    ...locator,
    scope,
    revision: 2,
    enabled: true,
    created_at: new Date(),
    updated_at: new Date(),
  };

  beforeEach(() => {
    activeKeyIds = [];
    queryMock.mockReset().mockImplementation(async (sql) => {
      const text = `${sql}`;
      if (text.includes("FROM agent_cocalc_connector_turns")) {
        return { rows: activeKeyIds.map((key_id) => ({ key_id })) };
      }
      return { rows: [saved] };
    });
    directoryDeleteMock.mockReset().mockResolvedValue(undefined);
    releaseMock.mockReset();
    homeMock.mockReset().mockResolvedValue({ home_bay_id: "bay-0" });
    freshAuthMock.mockReset().mockResolvedValue(undefined);
    identityMock.mockReset().mockResolvedValue({
      agent_id: agentId,
      project_id: projectId,
      disabled_at: null,
    });
    projectsMock.mockReset().mockResolvedValue(undefined);
    sourceMock.mockReset().mockResolvedValue(undefined);
  });

  it("reads only from the account home for an accessible native agent", async () => {
    const { getCocalcConnectorConfig } =
      await import("./cocalc-connector-config");
    await expect(getCocalcConnectorConfig(locator)).resolves.toEqual(saved);
    expect(homeMock).toHaveBeenCalledWith({
      account_id: accountId,
      user_account_id: accountId,
    });
    expect(identityMock).toHaveBeenCalledWith({
      account_id: accountId,
      agent_id: agentId,
      project_id: projectId,
    });
    expect(sourceMock).toHaveBeenCalledWith({
      account_id: accountId,
      project_id: projectId,
    });
    homeMock.mockResolvedValueOnce({ home_bay_id: "bay-1" });
    await expect(getCocalcConnectorConfig(locator)).rejects.toThrow(
      "not on account home",
    );
  });

  it("lists only the account's own settings, and only at its home", async () => {
    const { listCocalcConnectorConfigs } =
      await import("./cocalc-connector-config");
    await expect(listCocalcConnectorConfigs(locator)).resolves.toEqual([saved]);
    const [sql, params] = queryMock.mock.calls.at(-1)!;
    expect(`${sql}`).toContain("WHERE account_id=$1");
    expect(params).toEqual([accountId]);
    await expect(listCocalcConnectorConfigs({})).rejects.toThrow(
      "invalid account_id",
    );
    homeMock.mockResolvedValueOnce({ home_bay_id: "bay-9" });
    await expect(listCocalcConnectorConfigs(locator)).rejects.toThrow(
      "not on account home",
    );
  });

  it("rejects source-project access loss on read and save", async () => {
    const { getCocalcConnectorConfig, saveCocalcConnectorConfig } =
      await import("./cocalc-connector-config");
    sourceMock.mockRejectedValue(new Error("full collaborator required"));
    await expect(getCocalcConnectorConfig(locator)).rejects.toThrow(
      "full collaborator required",
    );
    await expect(
      saveCocalcConnectorConfig({ ...locator, scope, enabled: true }),
    ).rejects.toThrow("full collaborator required");
    expect(identityMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("requires bound fresh auth and a native agent before saving", async () => {
    const { saveCocalcConnectorConfig } =
      await import("./cocalc-connector-config");
    freshAuthMock.mockRejectedValueOnce(new Error("fresh auth required"));
    await expect(
      saveCocalcConnectorConfig({ ...locator, scope, enabled: true }),
    ).rejects.toThrow("fresh auth required");
    expect(queryMock).not.toHaveBeenCalled();

    identityMock.mockRejectedValueOnce(new Error("agent not found"));
    await expect(
      saveCocalcConnectorConfig({ ...locator, scope, enabled: true }),
    ).rejects.toThrow("agent not found");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("checks project access and uses a compare-and-swap revision", async () => {
    const { saveCocalcConnectorConfig } =
      await import("./cocalc-connector-config");
    await expect(
      saveCocalcConnectorConfig({
        ...locator,
        session_hash: "bound-session",
        expected_config_id: saved.config_id,
        expected_revision: 1,
        scope,
        enabled: true,
      }),
    ).resolves.toEqual(saved);
    expect(freshAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: accountId,
        session_hash: "bound-session",
        require_second_factor: true,
        allow_actor_impersonation: false,
      }),
    );
    expect(projectsMock).toHaveBeenCalledWith({
      account_id: accountId,
      scope,
    });
    expect(
      queryMock.mock.calls.find(([sql]) =>
        `${sql}`.includes("UPDATE agent_cocalc_connector_configs"),
      )?.[1][6],
    ).toBe(1);
    const original = queryMock.getMockImplementation()!;
    queryMock.mockImplementation(async (sql, args) =>
      `${sql}`.includes("UPDATE agent_cocalc_connector_configs")
        ? { rows: [] }
        : await original(sql, args),
    );
    await expect(
      saveCocalcConnectorConfig({
        ...locator,
        expected_config_id: saved.config_id,
        expected_revision: 1,
        scope,
        enabled: true,
      }),
    ).rejects.toThrow("reload before saving");
  });

  it("revokes active turn keys before a configuration change commits", async () => {
    activeKeyIds = ["key-a", "key-b"];
    const { saveCocalcConnectorConfig } =
      await import("./cocalc-connector-config");
    await saveCocalcConnectorConfig({
      ...locator,
      expected_config_id: saved.config_id,
      expected_revision: 1,
      scope,
      enabled: false,
    });
    expect(directoryDeleteMock).toHaveBeenCalledTimes(2);
    expect(directoryDeleteMock).toHaveBeenCalledWith({
      key_id: "key-a",
      account_id: accountId,
      home_bay_id: "bay-0",
    });
    const statements = queryMock.mock.calls.map(([sql]) => `${sql}`);
    expect(statements.indexOf("COMMIT")).toBeGreaterThan(
      statements.findIndex((sql) => sql.includes("DELETE FROM api_keys")),
    );
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("rolls back a configuration change if revocation cannot be confirmed", async () => {
    activeKeyIds = ["key-a"];
    directoryDeleteMock.mockRejectedValue(new Error("directory unavailable"));
    const { saveCocalcConnectorConfig } =
      await import("./cocalc-connector-config");
    await expect(
      saveCocalcConnectorConfig({
        ...locator,
        expected_config_id: saved.config_id,
        expected_revision: 1,
        scope,
        enabled: false,
      }),
    ).rejects.toThrow("directory unavailable");
    expect(queryMock.mock.calls.map(([sql]) => `${sql}`)).toContain("ROLLBACK");
    expect(queryMock.mock.calls.map(([sql]) => `${sql}`)).not.toContain(
      "COMMIT",
    );
  });

  it("disables empty settings and revokes turns, but cannot enable an empty scope", async () => {
    activeKeyIds = ["key-a"];
    const { saveCocalcConnectorConfig } =
      await import("./cocalc-connector-config");
    const empty = { version: 1 as const, account: [], projects: [] };
    await saveCocalcConnectorConfig({
      ...locator,
      expected_config_id: saved.config_id,
      expected_revision: 1,
      scope: empty,
      enabled: false,
    });
    const insert = queryMock.mock.calls.find(([sql]) =>
      `${sql}`.includes("UPDATE agent_cocalc_connector_configs"),
    );
    expect(JSON.parse(insert?.[1][4])).toEqual(empty);
    expect(insert?.[1][5]).toBe(false);
    expect(projectsMock).not.toHaveBeenCalled();
    expect(directoryDeleteMock).toHaveBeenCalledWith(
      expect.objectContaining({ key_id: "key-a" }),
    );
    expect(
      queryMock.mock.calls.some(([sql]) =>
        `${sql}`.includes("DELETE FROM api_keys"),
      ),
    ).toBe(true);
    expect(queryMock.mock.calls.map(([sql]) => sql)).toContain("COMMIT");
    queryMock.mockClear();
    await expect(
      saveCocalcConnectorConfig({ ...locator, scope: empty, enabled: true }),
    ).rejects.toThrow("at least one capability");
    expect(queryMock).not.toHaveBeenCalled();
  });

  const removal = {
    ...locator,
    session_hash: "bound-session",
    expected_config_id: saved.config_id,
    expected_revision: saved.revision,
  };

  it("requires fresh auth, source access and account home before removal", async () => {
    const { removeCocalcConnectorConfig } =
      await import("./cocalc-connector-config");
    freshAuthMock.mockRejectedValueOnce(new Error("fresh auth required"));
    await expect(removeCocalcConnectorConfig(removal)).rejects.toThrow(
      "fresh auth required",
    );
    sourceMock.mockRejectedValueOnce(new Error("full collaborator required"));
    await expect(removeCocalcConnectorConfig(removal)).rejects.toThrow(
      "full collaborator required",
    );
    homeMock.mockResolvedValueOnce({ home_bay_id: "other-bay" });
    await expect(removeCocalcConnectorConfig(removal)).rejects.toThrow(
      "not on account home",
    );
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("rolls back removal when active credential revocation fails", async () => {
    activeKeyIds = ["key-a"];
    directoryDeleteMock.mockRejectedValueOnce(
      new Error("revocation unavailable"),
    );
    const { removeCocalcConnectorConfig } =
      await import("./cocalc-connector-config");
    await expect(removeCocalcConnectorConfig(removal)).rejects.toThrow(
      "revocation unavailable",
    );
    expect(queryMock).toHaveBeenCalledWith("ROLLBACK");
    expect(queryMock).not.toHaveBeenCalledWith("COMMIT");
  });

  const describeDb =
    process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;
  describeDb("configuration lifecycle SQL", () => {
    let pool;
    beforeAll(async () => {
      pool = jest.requireActual("@cocalc/database/pool").default();
      await pool.query(`
        CREATE TABLE agent_cocalc_connector_configs (
          config_id uuid PRIMARY KEY, account_id uuid, agent_id uuid, source_project_id uuid,
          scope jsonb, revision integer DEFAULT 1, enabled boolean,
          created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
          UNIQUE(account_id,agent_id,source_project_id))`);
      await pool.query(`CREATE TABLE agent_cocalc_connector_turns (
          account_id uuid, agent_id uuid, source_project_id uuid, key_id text,
          ended_at timestamptz, expires_at timestamptz, secret_ciphertext text)`);
      await pool.query("CREATE TABLE api_keys (account_id uuid, key_id text)");
    });
    beforeEach(async () => {
      await pool.query(
        "TRUNCATE agent_cocalc_connector_configs,agent_cocalc_connector_turns,api_keys",
      );
      queryMock.mockImplementation((sql, args) => pool.query(sql, args));
    });
    afterAll(async () => {
      await pool.end();
    });

    it("removes, returns null, rejects stale saves, and permits explicit re-add", async () => {
      const {
        saveCocalcConnectorConfig: save,
        removeCocalcConnectorConfig: remove,
        getCocalcConnectorConfig: get,
      } = await import("./cocalc-connector-config");
      const original = await save({ ...locator, scope, enabled: true });
      const expected = {
        ...locator,
        expected_config_id: original.config_id,
        expected_revision: original.revision,
      };
      const disabled = await save({ ...expected, scope, enabled: false });
      await expect(remove(expected)).rejects.toThrow("reload before removing");
      expected.expected_revision = disabled.revision;
      await remove(expected);
      expect(await get(locator)).toBeNull();
      await expect(save({ ...expected, scope, enabled: true })).rejects.toThrow(
        "reload before saving",
      );
      const replacement = await save({ ...locator, scope, enabled: true });
      expect(replacement.config_id).not.toBe(original.config_id);
      // Same revision, different config: old windows must not change the replacement.
      expected.expected_revision = replacement.revision;
      await expect(remove(expected)).rejects.toThrow("reload before removing");
      await expect(
        save({ ...expected, scope, enabled: false }),
      ).rejects.toThrow("reload before saving");
      await expect(save({ ...locator, scope, enabled: false })).rejects.toThrow(
        "reload before saving",
      );
      expect(await get(locator)).toEqual(replacement);
    });

    it("atomically deletes settings and active keys, retaining settings on revocation failure", async () => {
      const {
        saveCocalcConnectorConfig: save,
        removeCocalcConnectorConfig: remove,
        getCocalcConnectorConfig: get,
      } = await import("./cocalc-connector-config");
      const config = await save({ ...locator, scope, enabled: true });
      await pool.query("INSERT INTO api_keys VALUES($1,'key-a')", [accountId]);
      await pool.query(
        `INSERT INTO agent_cocalc_connector_turns VALUES($1,$2,$3,'key-a',NULL,now()+interval '1 hour','ciphertext')`,
        [accountId, agentId, projectId],
      );
      const expected = {
        ...locator,
        expected_config_id: config.config_id,
        expected_revision: config.revision,
      };
      directoryDeleteMock.mockRejectedValueOnce(
        new Error("revocation unavailable"),
      );
      await expect(remove(expected)).rejects.toThrow("revocation unavailable");
      expect(await get(locator)).toEqual(config);
      expect((await pool.query("SELECT * FROM api_keys")).rows).toHaveLength(1);
      await remove(expected);
      expect(await get(locator)).toBeNull();
      expect((await pool.query("SELECT * FROM api_keys")).rows).toHaveLength(0);
      const turn = (
        await pool.query("SELECT * FROM agent_cocalc_connector_turns")
      ).rows[0];
      expect(turn.ended_at).not.toBeNull();
      expect(turn.secret_ciphertext).toBe("");
    });
  });
});
