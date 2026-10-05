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
const releaseMock = jest.fn();
const lockedMock = jest.fn();
let settings: Record<string, string>;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    query: (...args: any[]) => queryMock(...args),
    connect: async () => ({
      query: (...args: any[]) => queryMock(...args),
      release: () => releaseMock(),
    }),
  })),
}));
jest.mock("@cocalc/server/external-credentials/store", () => ({
  createExternalCredential: (...a: any[]) => createMock(...a),
  getExternalCredentialById: (...a: any[]) => getByIdMock(...a),
  listExternalCredentials: (...a: any[]) => listMock(...a),
  revokeExternalCredential: (...a: any[]) => revokeMock(...a),
  updateExternalCredentialPayloadLocked: (...a: any[]) => lockedMock(...a),
}));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => settings,
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
  connector: "github",
  connection_id: connectionId,
  scope: {},
  revision: 1,
  enabled: true,
  created_at: new Date(),
  updated_at: new Date(),
};
const NOW = 1_000_000;
const HOUR = 3_600_000;
const githubPayload = (access_expires_at = NOW + 8 * HOUR) => ({
  version: 2,
  type: "github-app",
  client_id: "Iv23test",
  access_token: "ghu_access",
  access_expires_at,
  refresh_token: "ghr_refresh",
  refresh_expires_at: NOW + 1000 * HOUR,
});
let connection: { id: string; payload: string; metadata: any };

// Answers GitHub endpoints by URL; records every request.
function github(routes: Record<string, unknown>) {
  return jest.fn(async (url: string, init?: any) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const body = routes[key];
    if (body === undefined) throw Error(`unexpected ${key}`);
    return { ok: true, status: 200, json: async () => body };
  }) as any;
}

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
    releaseMock,
    lockedMock,
  ]) {
    mock.mockReset().mockResolvedValue(undefined);
  }
  settings = {
    github_connector_client_id: "Iv23test",
    github_connector_client_secret: "secret",
    github_connector_app_url: "https://github.com/apps/cocalc-test",
  };
  connection = {
    id: connectionId,
    payload: JSON.stringify(githubPayload()),
    metadata: { description: "@octo" },
  };
  // A stored credential updated under its lock, as the real store does.
  lockedMock.mockImplementation(async ({ update }) => {
    const next = await update(connection);
    if (next) {
      connection = {
        ...connection,
        payload: next.payload,
        metadata: next.metadata ?? connection.metadata,
      };
    }
    return connection;
  });
  queryMock.mockResolvedValue({ rows: [grant] });
  createMock.mockResolvedValue({ id: connectionId, created: true });
  getByIdMock.mockImplementation(async () => connection);
});

describe("signing in to GitHub", () => {
  const deviceCode = {
    device_code: "dev-123",
    user_code: "ABCD-1234",
    verification_uri: "https://github.com/login/device",
    expires_in: 900,
    interval: 5,
  };

  it("starts only with fresh auth, and keeps the device code on the hub", async () => {
    const { startCliConnectorSignIn } = await import("./cli-connectors");
    const fetchImpl = github({
      "POST https://github.com/login/device/code": deviceCode,
    });
    const started = await startCliConnectorSignIn({
      account_id: accountId,
      session_hash: "s",
      connector: "github",
      fetchImpl,
    });
    expect(freshAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: accountId,
        session_hash: "s",
        require_second_factor: true,
      }),
    );
    expect(started).toEqual(
      expect.objectContaining({
        connector: "github",
        login_id: connectionId,
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
      }),
    );
    expect(JSON.stringify(started)).not.toContain("dev-123");
    const saved = createMock.mock.calls[0][0];
    expect(saved.selector).toEqual(
      expect.objectContaining({
        kind: "github-device-login",
        owner_account_id: accountId,
      }),
    );
    expect(JSON.parse(saved.payload).device_code).toBe("dev-123");
    // Abandoned sign-ins expire as leases instead of using up the limit.
    expect(Date.parse(saved.metadata.lease_expires_at)).toBeGreaterThan(
      Date.now(),
    );
  });

  it("refuses when the site has no GitHub App, or for other connectors", async () => {
    const { startCliConnectorSignIn } = await import("./cli-connectors");
    settings.github_connector_client_secret = "";
    await expect(
      startCliConnectorSignIn({ account_id: accountId, connector: "github" }),
    ).rejects.toThrow("GitHub is not set up on this site");
    await expect(
      startCliConnectorSignIn({ account_id: accountId, connector: "gitlab" }),
    ).rejects.toThrow("unknown CLI connector");
    expect(freshAuthMock).not.toHaveBeenCalled();
  });

  const pending = (expires_at = Date.now() + 600_000) => ({
    id: connectionId,
    payload: JSON.stringify({
      version: 1,
      type: "github-device-login",
      client_id: "Iv23test",
      device_code: "dev-123",
      expires_at,
    }),
    metadata: {},
  });

  it("waits while the user has not approved yet", async () => {
    const { pollCliConnectorSignIn } = await import("./cli-connectors");
    getByIdMock.mockResolvedValue(pending());
    const fetchImpl = github({
      "POST https://github.com/login/oauth/access_token": {
        error: "authorization_pending",
      },
    });
    await expect(
      pollCliConnectorSignIn({
        account_id: accountId,
        connector: "github",
        login_id: connectionId,
        fetchImpl,
      }),
    ).resolves.toEqual({ status: "pending" });
    expect(createMock).not.toHaveBeenCalled();
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it("stores the expiring tokens as a connection once approved", async () => {
    const { pollCliConnectorSignIn } = await import("./cli-connectors");
    getByIdMock.mockResolvedValue(pending());
    const fetchImpl = github({
      "POST https://github.com/login/oauth/access_token": {
        access_token: "ghu_new",
        expires_in: 28800,
        refresh_token: "ghr_new",
        refresh_token_expires_in: 15811200,
      },
      "GET https://api.github.com/user": { login: "octocat" },
    });
    const result = await pollCliConnectorSignIn({
      account_id: accountId,
      connector: "github",
      login_id: connectionId,
      fetchImpl,
    });
    expect(result).toEqual({
      status: "connected",
      connection: expect.objectContaining({ description: "@octocat" }),
    });
    const saved = createMock.mock.calls[0][0];
    expect(saved.selector.kind).toBe("github-cli-connection");
    expect(JSON.parse(saved.payload)).toEqual(
      expect.objectContaining({
        type: "github-app",
        access_token: "ghu_new",
        refresh_token: "ghr_new",
      }),
    );
    // The pending sign-in is consumed.
    expect(revokeMock).toHaveBeenCalledWith({
      id: connectionId,
      owner_account_id: accountId,
    });
  });

  it("refuses an app whose tokens do not expire, and revokes that token", async () => {
    const { pollCliConnectorSignIn } = await import("./cli-connectors");
    getByIdMock.mockResolvedValue(pending());
    const fetchImpl = github({
      "POST https://github.com/login/oauth/access_token": {
        access_token: "gho_forever",
      },
      "DELETE https://api.github.com/applications/Iv23test/token": {},
    });
    await expect(
      pollCliConnectorSignIn({
        account_id: accountId,
        connector: "github",
        login_id: connectionId,
        fetchImpl,
      }),
    ).rejects.toThrow("Expire user authorization tokens");
    expect(createMock).not.toHaveBeenCalled();
    const revoke = fetchImpl.mock.calls.find(
      ([, init]) => init?.method === "DELETE",
    );
    expect(JSON.parse(revoke[1].body)).toEqual({ access_token: "gho_forever" });
  });

  it("an expired or another account's sign-in gives nothing", async () => {
    const { pollCliConnectorSignIn } = await import("./cli-connectors");
    getByIdMock.mockResolvedValue(undefined);
    await expect(
      pollCliConnectorSignIn({
        account_id: accountId,
        connector: "github",
        login_id: connectionId,
      }),
    ).resolves.toEqual({ status: "expired" });
    expect(getByIdMock.mock.calls[0][0].selector.owner_account_id).toBe(
      accountId,
    );
    getByIdMock.mockResolvedValue(pending(Date.now() - 1));
    await expect(
      pollCliConnectorSignIn({
        account_id: accountId,
        connector: "github",
        login_id: connectionId,
      }),
    ).resolves.toEqual({ status: "expired" });
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe("signing in to Cloudflare", () => {
  it("asks only for the scopes of the chosen presets", async () => {
    const { startCliConnectorSignIn } = await import("./cli-connectors");
    const fetchImpl = github({
      "POST https://dash.cloudflare.com/oauth2/device/auth": {
        device_code: "cf-dev",
        user_code: "WXYZ-9876",
        verification_uri: "https://dash.cloudflare.com/oauth2/device",
        expires_in: 600,
        interval: 5,
      },
    });
    const started = await startCliConnectorSignIn({
      account_id: accountId,
      session_hash: "s",
      connector: "cloudflare",
      presets: ["r2"],
      fetchImpl,
    });
    expect(started.user_code).toBe("WXYZ-9876");
    expect(freshAuthMock).toHaveBeenCalled();
    const form = new URLSearchParams(fetchImpl.mock.calls[0][1].body);
    expect(form.get("client_id")).toBe("cbca97e7-c331-4cdd-8fd8-e25a451b98bf");
    expect(form.get("scope")!.split(" ").sort()).toEqual(
      [
        "account:read",
        "user:read",
        "workers-r2.read",
        "workers-r2.write",
        "workers-r2-bucket-item.read",
        "workers-r2-bucket-item.write",
        "offline_access",
      ].sort(),
    );
    expect(createMock.mock.calls[0][0].selector).toEqual(
      expect.objectContaining({
        provider: "cloudflare",
        kind: "cloudflare-device-login",
      }),
    );
  });

  it("needs at least one known preset, and the site may turn it off", async () => {
    const { startCliConnectorSignIn, getCliConnectorSetup } =
      await import("./cli-connectors");
    for (const presets of [undefined, [], ["everything"]]) {
      await expect(
        startCliConnectorSignIn({
          account_id: accountId,
          connector: "cloudflare",
          presets: presets as any,
        }),
      ).rejects.toThrow(/Cloudflare/);
    }
    settings.cloudflare_connector_enabled = false as any;
    await expect(
      startCliConnectorSignIn({
        account_id: accountId,
        connector: "cloudflare",
        presets: ["dns"],
      }),
    ).rejects.toThrow("Cloudflare is not set up on this site");
    expect(
      (await getCliConnectorSetup({ account_id: accountId })).cloudflare,
    ).toEqual({ available: false });
    expect(freshAuthMock).not.toHaveBeenCalled();
  });

  it("refuses a verification page outside dash.cloudflare.com", async () => {
    const { startCliConnectorSignIn } = await import("./cli-connectors");
    const fetchImpl = github({
      "POST https://dash.cloudflare.com/oauth2/device/auth": {
        device_code: "cf-dev",
        user_code: "WXYZ-9876",
        verification_uri: "https://dash.cloudflare.com.evil.example/device",
      },
    });
    await expect(
      startCliConnectorSignIn({
        account_id: accountId,
        connector: "cloudflare",
        presets: ["dns"],
        fetchImpl,
      }),
    ).rejects.toThrow("unexpected response");
  });

  it("stores the connection with who and what it allows", async () => {
    const { pollCliConnectorSignIn } = await import("./cli-connectors");
    getByIdMock.mockResolvedValue({
      id: connectionId,
      payload: JSON.stringify({
        version: 1,
        type: "cloudflare-device-login",
        client_id: "cbca97e7-c331-4cdd-8fd8-e25a451b98bf",
        device_code: "cf-dev",
        presets: ["workers", "r2"],
        expires_at: Date.now() + 600_000,
      }),
      metadata: {},
    });
    const fetchImpl = github({
      "POST https://dash.cloudflare.com/oauth2/token": {
        access_token: "cf-access",
        expires_in: 3600,
        refresh_token: "cf-refresh",
      },
      "GET https://api.cloudflare.com/client/v4/user": {
        success: true,
        result: { email: "me@example.com" },
      },
    });
    const result = await pollCliConnectorSignIn({
      account_id: accountId,
      connector: "cloudflare",
      login_id: connectionId,
      fetchImpl,
    });
    expect(result).toEqual({
      status: "connected",
      connection: expect.objectContaining({
        connector: "cloudflare",
        description: "me@example.com (Workers & sites, R2 storage)",
      }),
    });
    const saved = createMock.mock.calls[0][0];
    expect(saved.selector.kind).toBe("cloudflare-cli-connection");
    expect(JSON.parse(saved.payload)).toEqual(
      expect.objectContaining({
        type: "cloudflare-oauth",
        presets: ["workers", "r2"],
        refresh_token: "cf-refresh",
      }),
    );
  });

  it("a GitHub sign-in cannot be finished as Cloudflare", async () => {
    const { pollCliConnectorSignIn } = await import("./cli-connectors");
    await pollCliConnectorSignIn({
      account_id: accountId,
      connector: "cloudflare",
      login_id: connectionId,
    });
    expect(getByIdMock.mock.calls[0][0].selector.kind).toBe(
      "cloudflare-device-login",
    );
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

  it("turning off needs no fresh auth, and only updates an existing grant", async () => {
    const { saveCliConnectorGrant } = await import("./cli-connectors");
    await saveCliConnectorGrant({
      ...base,
      enabled: false,
      expected_revision: 1,
    });
    expect(configChangeMock).not.toHaveBeenCalled();
    expect(homeMock).toHaveBeenCalled();
    const [sql, params] = queryMock.mock.calls.at(-1)!;
    expect(sql).toMatch(/^\s*UPDATE agent_connector_grants/);
    expect(sql).not.toMatch(/INSERT/);
    expect(params.at(-1)).toBe(1);
    // Without the revision the user saw, nothing is written.
    queryMock.mockClear();
    await expect(
      saveCliConnectorGrant({ ...base, enabled: false }),
    ).rejects.toThrow("invalid grant revision");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("turning on over an existing grant needs its revision", async () => {
    const { saveCliConnectorGrant } = await import("./cli-connectors");
    await saveCliConnectorGrant({
      ...base,
      enabled: true,
      connection_id: connectionId,
    });
    const [sql, params] = queryMock.mock.calls.find(([q]) =>
      /INSERT INTO agent_connector_grants/.test(q),
    )!;
    // A missing revision is NULL, which never matches an existing row.
    expect(sql).toContain("WHERE agent_connector_grants.revision=$8::integer");
    expect(sql).not.toMatch(/IS NULL/);
    expect(params[7]).toBeNull();
  });

  it("bounds how many grants an account can create", async () => {
    const { saveCliConnectorGrant } = await import("./cli-connectors");
    queryMock.mockImplementation(async (q: string) =>
      /count\(\*\)/.test(q) ? { rows: [{ count: "500" }] } : { rows: [grant] },
    );
    await expect(
      saveCliConnectorGrant({
        ...base,
        enabled: true,
        connection_id: connectionId,
      }),
    ).rejects.toThrow("too many agents");
    // The count happens inside the transaction, after the account lock.
    const sql = queryMock.mock.calls.map(([q]) => `${q}`.trim());
    const lock = sql.findIndex((q) => /pg_advisory_xact_lock/.test(q));
    expect(sql[lock - 1]).toBe("BEGIN");
    expect(sql[lock + 1]).toMatch(/count\(\*\)/);
    expect(sql).toContain("ROLLBACK");
    expect(releaseMock).toHaveBeenCalled();
    // Changing an existing grant is not a new row.
    await saveCliConnectorGrant({
      ...base,
      enabled: true,
      connection_id: connectionId,
      expected_revision: 1,
    });
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
    now: NOW,
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
        connector: "github",
        token: "ghu_access",
        expires_at: NOW + 8 * HOUR,
        description: "@octo",
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

  it("reads the grants again under a lock after the turn checks", async () => {
    const { issueCliConnectorTurnTokens } = await import("./cli-connectors");
    await issueCliConnectorTurnTokens(request);
    const sql = queryMock.mock.calls.map(([q]) => `${q}`.trim());
    const locked = sql.findIndex((q) => /FOR SHARE/.test(q));
    expect(sql[locked - 1]).toBe("BEGIN");
    expect(sql.at(-1)).toBe("COMMIT");
    expect(liveTurnMock.mock.invocationCallOrder[0]).toBeLessThan(
      queryMock.mock.invocationCallOrder[locked],
    );
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("a grant turned off during the turn checks hands out nothing", async () => {
    const { issueCliConnectorTurnTokens } = await import("./cli-connectors");
    queryMock.mockImplementation(async (q: string) =>
      /FOR SHARE/.test(q) ? { rows: [] } : { rows: [grant] },
    );
    await expect(issueCliConnectorTurnTokens(request)).resolves.toEqual([]);
    expect(lockedMock).not.toHaveBeenCalled();
  });

  it("rolls back and releases on failure", async () => {
    const { issueCliConnectorTurnTokens } = await import("./cli-connectors");
    lockedMock.mockRejectedValueOnce(Error("decrypt failed"));
    await expect(issueCliConnectorTurnTokens(request)).rejects.toThrow(
      "decrypt failed",
    );
    expect(queryMock.mock.calls.map(([q]) => `${q}`.trim())).toContain(
      "ROLLBACK",
    );
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("skips a connection that no longer exists", async () => {
    const { issueCliConnectorTurnTokens } = await import("./cli-connectors");
    lockedMock.mockResolvedValueOnce(undefined);
    await expect(issueCliConnectorTurnTokens(request)).resolves.toEqual([]);
  });

  it("refreshes a token close to expiry, under the connection's lock", async () => {
    const { issueCliConnectorTurnTokens } = await import("./cli-connectors");
    connection.payload = JSON.stringify(githubPayload(NOW + 60_000));
    const fetchImpl = github({
      "POST https://github.com/login/oauth/access_token": {
        access_token: "ghu_fresh",
        expires_in: 28800,
        refresh_token: "ghr_fresh",
        refresh_token_expires_in: 15811200,
      },
    });
    const tokens = await issueCliConnectorTurnTokens({ ...request, fetchImpl });
    expect(tokens).toEqual([
      expect.objectContaining({
        token: "ghu_fresh",
        expires_at: NOW + 8 * HOUR,
      }),
    ]);
    const form = new URLSearchParams(fetchImpl.mock.calls[0][1].body);
    expect(Object.fromEntries(form)).toEqual({
      client_id: "Iv23test",
      client_secret: "secret",
      grant_type: "refresh_token",
      refresh_token: "ghr_refresh",
    });
    // GitHub rotates refresh tokens; the new one is stored.
    expect(JSON.parse(connection.payload).refresh_token).toBe("ghr_fresh");
  });

  it("a refused refresh marks the connection for signing in again", async () => {
    const { issueCliConnectorTurnTokens } = await import("./cli-connectors");
    connection.payload = JSON.stringify(githubPayload(NOW + 60_000));
    const fetchImpl = github({
      "POST https://github.com/login/oauth/access_token": {
        error: "bad_refresh_token",
      },
    });
    await expect(
      issueCliConnectorTurnTokens({ ...request, fetchImpl }),
    ).resolves.toEqual([]);
    expect(connection.metadata.needs_reconnect).toBe(true);
    // And it is not retried on later turns.
    fetchImpl.mockClear();
    await issueCliConnectorTurnTokens({ ...request, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes a Cloudflare token, keeping its refresh token if not rotated", async () => {
    const { issueCliConnectorTurnTokens } = await import("./cli-connectors");
    queryMock.mockResolvedValue({
      rows: [{ ...grant, connector: "cloudflare" }],
    });
    connection = {
      id: connectionId,
      payload: JSON.stringify({
        version: 2,
        type: "cloudflare-oauth",
        client_id: "cbca97e7-c331-4cdd-8fd8-e25a451b98bf",
        presets: ["r2"],
        access_token: "cf-old",
        access_expires_at: NOW + 60_000,
        refresh_token: "cf-refresh",
      }),
      metadata: { description: "me@example.com (R2 storage)" },
    };
    const fetchImpl = github({
      "POST https://dash.cloudflare.com/oauth2/token": {
        access_token: "cf-new",
        expires_in: 3600,
      },
    });
    const tokens = await issueCliConnectorTurnTokens({ ...request, fetchImpl });
    expect(tokens).toEqual([
      {
        connector: "cloudflare",
        token: "cf-new",
        expires_at: NOW + HOUR,
        description: "me@example.com (R2 storage)",
      },
    ]);
    const stored = JSON.parse(connection.payload);
    expect(stored.access_token).toBe("cf-new");
    expect(stored.refresh_token).toBe("cf-refresh");
  });

  it("gives no GitHub token when the site's app is gone or changed", async () => {
    const { issueCliConnectorTurnTokens } = await import("./cli-connectors");
    settings.github_connector_client_id = "";
    await expect(issueCliConnectorTurnTokens(request)).resolves.toEqual([]);
    settings.github_connector_client_id = "Iv23other";
    await expect(issueCliConnectorTurnTokens(request)).resolves.toEqual([]);
    expect(connection.metadata.needs_reconnect).toBe(true);
  });
});

describe("disconnecting", () => {
  it("turns off grants and revokes only a CLI connection", async () => {
    const { disconnectCliConnection } = await import("./cli-connectors");
    const fetchMock = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true, status: 204 } as any);
    await disconnectCliConnection({
      account_id: accountId,
      connection_id: connectionId,
    });
    // GitHub invalidates the token too.
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.github.com/applications/Iv23test/token",
    );
    fetchMock.mockRestore();
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
