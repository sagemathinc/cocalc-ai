/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

export {};

const accountId = "00000000-0000-4000-8000-000000000001";
const agentId = "00000000-0000-4000-8000-000000000002";
const projectId = "00000000-0000-4000-8000-000000000003";
const hostId = "00000000-0000-4000-8000-000000000004";
const runId = "00000000-0000-4000-8000-000000000005";
const connectionId = "00000000-0000-4000-8000-000000000006";

const queryMock = jest.fn();
const homeMock = jest.fn();
const freshAuthMock = jest.fn();
const configChangeMock = jest.fn();
const trustedSourceMock = jest.fn();
const liveTurnMock = jest.fn();
const activeRunMock = jest.fn();
const createMock = jest.fn();
const getByIdMock = jest.fn();
const listMock = jest.fn();
const revokeMock = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: (...args: any[]) => queryMock(...args) })),
}));
jest.mock("@cocalc/server/external-credentials/store", () => ({
  createExternalCredential: (...a: any[]) => createMock(...a),
  getExternalCredentialById: (...a: any[]) => getByIdMock(...a),
  listExternalCredentials: (...a: any[]) => listMock(...a),
  revokeExternalCredential: (...a: any[]) => revokeMock(...a),
}));
jest.mock("@cocalc/server/conat/api/dangerous-session-auth", () => ({
  requireDangerousSessionAuth: (...a: any[]) => freshAuthMock(...a),
}));
jest.mock("./cocalc-connector-config", () => ({
  assertAccountHome: (...a: any[]) => homeMock(...a),
  authorizeConfigChange: (...a: any[]) => configChangeMock(...a),
}));
jest.mock("./cocalc-connector-turn", () => ({
  assertTrustedSource: (...a: any[]) => trustedSourceMock(...a),
  assertLiveTurn: (...a: any[]) => liveTurnMock(...a),
}));
jest.mock("./identity-routing", () => ({
  verifyActiveAgentRun: (...a: any[]) => activeRunMock(...a),
}));

const turn_ref = {
  chat_path: "/agents.chat",
  message_date: "2026-10-05T00:00:00.000Z",
  message_id: "m",
  thread_id: "t",
};
const grant = {
  grant_id: "00000000-0000-4000-8000-000000000007",
  account_id: accountId,
  agent_id: agentId,
  source_project_id: projectId,
  connector: "cloudflare",
  connection_id: connectionId,
  scope: {},
  revision: 1,
  enabled: true,
  created_at: new Date(),
  updated_at: new Date(),
};
const connection = {
  id: connectionId,
  payload: JSON.stringify({ version: 1, type: "token", token: "cf-token-123" }),
  metadata: { description: "API token" },
};

beforeEach(() => {
  for (const mock of [
    queryMock,
    homeMock,
    freshAuthMock,
    configChangeMock,
    trustedSourceMock,
    liveTurnMock,
    activeRunMock,
    createMock,
    getByIdMock,
    listMock,
    revokeMock,
  ]) {
    mock.mockReset().mockResolvedValue(undefined);
  }
  queryMock.mockResolvedValue({ rows: [grant] });
  createMock.mockResolvedValue({ id: connectionId, created: true });
  getByIdMock.mockResolvedValue(connection);
});

const okFetch = (body: unknown) =>
  jest.fn(async () => ({ ok: true, json: async () => body })) as any;

describe("connecting a pasted token", () => {
  it("needs fresh auth and the provider's acceptance, and stores who it is", async () => {
    const { connectCliToken } = await import("./cli-connectors");
    const result = await connectCliToken({
      account_id: accountId,
      session_hash: "s",
      connector: "github",
      token: " github_pat_1234567890 ",
      fetchImpl: okFetch({ login: "octocat" }),
    });
    expect(freshAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: accountId,
        session_hash: "s",
        require_second_factor: true,
      }),
    );
    expect(result.description).toBe("@octocat");
    const saved = createMock.mock.calls[0][0];
    expect(saved.selector).toEqual(
      expect.objectContaining({
        provider: "github",
        kind: "github-cli-connection",
        owner_account_id: accountId,
      }),
    );
    expect(JSON.parse(saved.payload)).toEqual({
      version: 1,
      type: "token",
      token: "github_pat_1234567890",
    });
  });

  it("refuses tokens the provider rejects, and malformed tokens", async () => {
    const { connectCliToken } = await import("./cli-connectors");
    await expect(
      connectCliToken({
        account_id: accountId,
        connector: "cloudflare",
        token: "cf-token-123456",
        fetchImpl: okFetch({ success: false }),
      }),
    ).rejects.toThrow("Cloudflare did not accept this token");
    await expect(
      connectCliToken({
        account_id: accountId,
        connector: "cloudflare",
        token: "has space in it",
      }),
    ).rejects.toThrow("does not look like an API token");
    await expect(
      connectCliToken({
        account_id: accountId,
        connector: "gitlab",
        token: "x".repeat(20),
      }),
    ).rejects.toThrow("unknown CLI connector");
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe("agent grants", () => {
  const base = {
    account_id: accountId,
    session_hash: "s",
    agent_id: agentId,
    source_project_id: projectId,
    connector: "cloudflare",
  };

  it("turning on needs fresh auth and a connection the account owns", async () => {
    const { saveCliConnectorGrant } = await import("./cli-connectors");
    await saveCliConnectorGrant({
      ...base,
      enabled: true,
      connection_id: connectionId,
    });
    expect(configChangeMock).toHaveBeenCalled();
    expect(getByIdMock.mock.calls[0][0].selector.owner_account_id).toBe(
      accountId,
    );
    getByIdMock.mockResolvedValueOnce(undefined);
    await expect(
      saveCliConnectorGrant({
        ...base,
        enabled: true,
        connection_id: connectionId,
      }),
    ).rejects.toThrow("connection is unavailable");
  });

  it("turning off needs no fresh auth", async () => {
    const { saveCliConnectorGrant } = await import("./cli-connectors");
    await saveCliConnectorGrant({ ...base, enabled: false });
    expect(configChangeMock).not.toHaveBeenCalled();
    expect(homeMock).toHaveBeenCalled();
  });

  it("a stale revision fails instead of overwriting", async () => {
    const { saveCliConnectorGrant } = await import("./cli-connectors");
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(
      saveCliConnectorGrant({ ...base, enabled: false, expected_revision: 3 }),
    ).rejects.toThrow("connector settings changed");
  });
});

describe("turn tokens", () => {
  const request = {
    account_id: accountId,
    host_id: hostId,
    agent_id: agentId,
    source_project_id: projectId,
    run_id: runId,
    turn_ref,
    now: 1_000,
  };

  it("returns nothing, cheaply, when the agent has no connector on", async () => {
    const { issueCliConnectorTurnTokens } = await import("./cli-connectors");
    queryMock.mockResolvedValueOnce({ rows: [{ ...grant, enabled: false }] });
    await expect(issueCliConnectorTurnTokens(request)).resolves.toEqual([]);
    expect(trustedSourceMock).toHaveBeenCalled();
    expect(liveTurnMock).not.toHaveBeenCalled();
  });

  it("verifies the run and the live turn before handing out tokens", async () => {
    const { issueCliConnectorTurnTokens } = await import("./cli-connectors");
    const tokens = await issueCliConnectorTurnTokens(request);
    expect(activeRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: runId, agent_id: agentId }),
    );
    expect(liveTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({ host_id: hostId, turn: turn_ref }),
    );
    expect(tokens).toEqual([
      {
        connector: "cloudflare",
        token: "cf-token-123",
        expires_at: 1_000 + 15 * 60_000,
        description: "API token",
      },
    ]);
  });

  it("a failed turn check hands out nothing", async () => {
    const { issueCliConnectorTurnTokens } = await import("./cli-connectors");
    liveTurnMock.mockRejectedValueOnce(Error("not the agent's turn"));
    await expect(issueCliConnectorTurnTokens(request)).rejects.toThrow(
      "not the agent's turn",
    );
  });

  it("skips a connection that no longer exists", async () => {
    const { issueCliConnectorTurnTokens } = await import("./cli-connectors");
    getByIdMock.mockResolvedValueOnce(undefined);
    await expect(issueCliConnectorTurnTokens(request)).resolves.toEqual([]);
  });
});

describe("disconnecting", () => {
  it("turns off grants and revokes only a CLI connection", async () => {
    const { disconnectCliConnection } = await import("./cli-connectors");
    await disconnectCliConnection({
      account_id: accountId,
      connection_id: connectionId,
    });
    expect(`${queryMock.mock.calls[0][0]}`).toContain("enabled=false");
    expect(revokeMock).toHaveBeenCalledWith({
      id: connectionId,
      owner_account_id: accountId,
    });
    getByIdMock.mockResolvedValue(undefined);
    await expect(
      disconnectCliConnection({
        account_id: accountId,
        connection_id: connectionId,
      }),
    ).rejects.toThrow("connection is unavailable");
    expect(revokeMock).toHaveBeenCalledTimes(1);
  });
});
