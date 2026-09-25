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

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: (...args: any[]) => queryMock(...args) })),
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
    queryMock.mockReset().mockResolvedValue({ rows: [saved] });
    homeMock.mockReset().mockResolvedValue({ home_bay_id: "bay-0" });
    freshAuthMock.mockReset().mockResolvedValue(undefined);
    identityMock.mockReset().mockResolvedValue({
      agent_id: agentId,
      project_id: projectId,
      disabled_at: null,
    });
    projectsMock.mockReset().mockResolvedValue(undefined);
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
    homeMock.mockResolvedValueOnce({ home_bay_id: "bay-1" });
    await expect(getCocalcConnectorConfig(locator)).rejects.toThrow(
      "not on account home",
    );
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
    expect(queryMock.mock.calls[0][1][6]).toBe(1);
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(
      saveCocalcConnectorConfig({
        ...locator,
        expected_revision: 1,
        scope,
        enabled: true,
      }),
    ).rejects.toThrow("reload before saving");
  });
});
