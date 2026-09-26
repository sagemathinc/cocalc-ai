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
        `${sql}`.includes("INSERT INTO agent_cocalc_connector_configs"),
      )?.[1][6],
    ).toBe(1);
    const original = queryMock.getMockImplementation()!;
    queryMock.mockImplementation(async (sql, args) =>
      `${sql}`.includes("INSERT INTO agent_cocalc_connector_configs")
        ? { rows: [] }
        : await original(sql, args),
    );
    await expect(
      saveCocalcConnectorConfig({
        ...locator,
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
      expected_revision: 1,
      scope: empty,
      enabled: false,
    });
    const insert = queryMock.mock.calls.find(([sql]) =>
      `${sql}`.includes("INSERT INTO agent_cocalc_connector_configs"),
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
});
