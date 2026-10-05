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
jest.mock("@cocalc/database/settings/site-url", () => ({
  __esModule: true,
  default: async () => "https://cocalc.test",
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
type Row = { id: string; payload: string; metadata: any };
let connection: Row;
// The pending sign-in row, if any.
let signInRow: Row | undefined;

// Answers provider endpoints by URL, as the global fetch; records every
// request. A body {status: n} answers with that HTTP status.
function github(routes: Record<string, unknown>) {
  const fetchMock = jest.fn(async (url: string, init?: any) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const body = routes[key] as any;
    if (body === undefined) throw Error(`unexpected ${key}`);
    const status = typeof body?.status === "number" ? body.status : 200;
    return {
      ok: status < 400,
      status,
      json: async () => body,
    };
  }) as any;
  jest.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
  return fetchMock;
}

afterEach(() => {
  jest.restoreAllMocks();
});

beforeEach(async () => {
  (await import("./cli-connectors")).resetProviderRequestBudget();
  // Server time; requests cannot supply their own.
  jest.spyOn(Date, "now").mockReturnValue(NOW);
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
    cloudflare_connector_client_id: "cf-client",
    cloudflare_connector_client_secret: "cf-secret",
  };
  connection = {
    id: connectionId,
    payload: JSON.stringify(githubPayload()),
    metadata: { description: "@octo" },
  };
  signInRow = undefined;
  // A stored credential updated under its lock, as the real store does.
  lockedMock.mockImplementation(async ({ selector, update }) => {
    const pending = `${selector.kind}`.endsWith("-login");
    const row = pending ? signInRow : connection;
    if (!row) return undefined;
    const next = await update(row);
    const updated = next
      ? {
          ...row,
          payload: next.payload,
          metadata: next.metadata ?? row.metadata,
        }
      : row;
    if (pending) signInRow = updated;
    else connection = updated;
    return updated;
  });
  queryMock.mockResolvedValue({ rows: [grant] });
  createMock.mockImplementation(async ({ selector, payload, metadata }) => {
    // A new pending sign-in becomes the row later updates work on.
    if (`${selector.kind}`.endsWith("-login")) {
      signInRow = { id: connectionId, payload, metadata };
    }
    return { id: connectionId, created: true };
  });
  getByIdMock.mockImplementation(async () => connection);
});

const GITHUB_TOKEN_URL = "POST https://github.com/login/oauth/access_token";
const GITHUB_REVOKE =
  "DELETE https://api.github.com/applications/Iv23test/token";
const CF_TOKEN_URL = "POST https://dash.cloudflare.com/oauth2/token";
const CF_REVOKE = "POST https://dash.cloudflare.com/oauth2/revoke";
const githubTokens = {
  access_token: "ghu_new",
  expires_in: 28800,
  refresh_token: "ghr_new",
  refresh_token_expires_in: 15811200,
};
const cfTokens = {
  access_token: "cf-access",
  expires_in: 3600,
  refresh_token: "cf-refresh",
};

function pendingSignIn(
  connector: "github" | "cloudflare",
  extra: Record<string, unknown> = {},
) {
  const login =
    connector === "github"
      ? {
          version: 1,
          type: "github-device-login",
          client_id: "Iv23test",
          device_code: "dev-123",
          expires_at: NOW + 600_000,
          interval: 5,
          next_poll_at: NOW,
        }
      : {
          version: 1,
          type: "cloudflare-oauth-login",
          client_id: "cf-client",
          redirect_uri: "https://cocalc.test/settings/connectors",
          nonce: "nonce-1",
          code_verifier: "verifier-1",
          presets: ["workers", "r2"],
          expires_at: NOW + 600_000,
          interval: 0,
          next_poll_at: 0,
        };
  signInRow = {
    id: connectionId,
    payload: JSON.stringify({ ...login, ...extra }),
    metadata: {},
  };
}

const STATE = `cocalc-cf.${connectionId}.nonce-1`;

async function complete(state = STATE, code = "code-1") {
  const { completeCliConnectorSignIn } = await import("./cli-connectors");
  return await completeCliConnectorSignIn({
    account_id: accountId,
    connector: "cloudflare",
    state,
    code,
  });
}

async function poll(
  connector: "github" | "cloudflare",
  _fetch?: unknown,
  now = NOW,
) {
  const { pollCliConnectorSignIn } = await import("./cli-connectors");
  jest.spyOn(Date, "now").mockReturnValue(now);
  return await pollCliConnectorSignIn({
    account_id: accountId,
    connector,
    login_id: connectionId,
  });
}

function revokes(fetchImpl: any): string[] {
  return fetchImpl.mock.calls
    .filter(([url]) => /revoke|applications/.test(url))
    .map(([url, init]) => `${init?.method} ${url} ${init?.body ?? ""}`);
}

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
    listMock.mockResolvedValue([]);
    const fetchImpl = github({
      "POST https://github.com/login/device/code": deviceCode,
    });
    const started = await startCliConnectorSignIn({
      account_id: accountId,
      session_hash: "s",
      connector: "github",
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
    // Reserved before GitHub was asked, then filled in.
    expect(JSON.parse(saved.payload)).toEqual(
      expect.objectContaining({ starting: true, device_code: "" }),
    );
    expect(JSON.parse(signInRow!.payload)).toEqual(
      expect.objectContaining({
        device_code: "dev-123",
        interval: 5,
        next_poll_at: NOW + 5000,
      }),
    );
    expect(signInRow!.payload).not.toContain('"starting"');
    // Abandoned sign-ins expire as leases instead of using up the limit.
    expect(Date.parse(saved.metadata.lease_expires_at)).toBeGreaterThan(NOW);
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

  it("enforces the polling interval on the hub, growing it on slow_down", async () => {
    pendingSignIn("github", { next_poll_at: NOW + 5000 });
    const fetchImpl = github({ [GITHUB_TOKEN_URL]: { error: "slow_down" } });
    // Too early: GitHub is not asked.
    await expect(poll("github", fetchImpl, NOW + 4999)).resolves.toEqual({
      status: "pending",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(poll("github", fetchImpl, NOW + 5000)).resolves.toEqual({
      status: "pending",
      slow_down: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const pending = JSON.parse(signInRow!.payload);
    expect(pending.interval).toBe(10);
    expect(pending.next_poll_at).toBe(NOW + 15000);
    await poll("github", fetchImpl, NOW + 14999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(createMock).not.toHaveBeenCalled();
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it("stores the expiring tokens as a connection once approved", async () => {
    pendingSignIn("github");
    const fetchImpl = github({
      [GITHUB_TOKEN_URL]: githubTokens,
      "GET https://api.github.com/user": { login: "octocat" },
    });
    await expect(poll("github", fetchImpl)).resolves.toEqual({
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
    // A retried finish updates the same connection instead of adding one.
    expect(saved.deduplicateMetadata).toEqual({
      key: "sign_in_id",
      value: connectionId,
    });
    // The sign-in no longer holds the tokens, and is consumed.
    expect(signInRow!.payload).not.toContain("ghu_new");
    expect(revokeMock).toHaveBeenCalledWith({
      id: connectionId,
      owner_account_id: accountId,
    });
    expect(revokes(fetchImpl)).toEqual([]);
  });

  it("revokes the new token when GitHub will not say who it is", async () => {
    pendingSignIn("github");
    const fetchImpl = github({
      [GITHUB_TOKEN_URL]: githubTokens,
      "GET https://api.github.com/user": { message: "Bad credentials" },
      [GITHUB_REVOKE]: {},
    });
    await expect(poll("github", fetchImpl)).rejects.toThrow(
      "GitHub did not accept the new sign-in",
    );
    expect(createMock).not.toHaveBeenCalled();
    expect(revokes(fetchImpl)).toEqual([
      `DELETE https://api.github.com/applications/Iv23test/token ${JSON.stringify(
        { access_token: "ghu_new" },
      )}`,
    ]);
    expect(signInRow!.payload).not.toContain("ghu_new");
    expect(revokeMock).toHaveBeenCalled();
  });

  it("revokes the new token when the connection cannot be stored", async () => {
    pendingSignIn("github");
    createMock.mockRejectedValue(
      Error("at most 10 active credentials are allowed"),
    );
    const fetchImpl = github({
      [GITHUB_TOKEN_URL]: githubTokens,
      "GET https://api.github.com/user": { login: "octocat" },
      [GITHUB_REVOKE]: {},
    });
    await expect(poll("github", fetchImpl)).rejects.toThrow("at most 10");
    expect(revokes(fetchImpl)).toHaveLength(1);
  });

  it("revokes the new token when it cannot even be recorded", async () => {
    pendingSignIn("github");
    // Writing the exchanged tokens fails (e.g. the database went away).
    const store = lockedMock.getMockImplementation()!;
    lockedMock.mockImplementation(async (opts) =>
      store({
        ...opts,
        update: async (row) => {
          const next = await opts.update(row);
          if (next?.payload.includes('"exchanged"')) {
            throw Error("database unavailable");
          }
          return next;
        },
      }),
    );
    const fetchImpl = github({
      [GITHUB_TOKEN_URL]: githubTokens,
      [GITHUB_REVOKE]: {},
    });
    await expect(poll("github", fetchImpl)).rejects.toThrow(
      "database unavailable",
    );
    expect(revokes(fetchImpl)).toHaveLength(1);
  });

  it("finishes a sign-in whose exchange was recorded before a crash", async () => {
    pendingSignIn("github", {
      exchanged: { ...githubPayload(), access_token: "ghu_saved" },
      exchanged_at: NOW - 1000,
    });
    const fetchImpl = github({
      "GET https://api.github.com/user": { login: "octocat" },
    });
    await expect(poll("github", fetchImpl)).resolves.toEqual(
      expect.objectContaining({ status: "connected" }),
    );
    // The device code is not exchanged twice.
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://api.github.com/user",
    ]);
    expect(JSON.parse(createMock.mock.calls[0][0].payload).access_token).toBe(
      "ghu_saved",
    );
  });

  it("revokes tokens of a sign-in left unfinished, when the next one starts", async () => {
    const { startCliConnectorSignIn } = await import("./cli-connectors");
    pendingSignIn("github", {
      exchanged: { ...githubPayload(), access_token: "ghu_orphan" },
      exchanged_at: NOW - 3 * 60_000,
    });
    listMock.mockResolvedValue([{ id: connectionId }]);
    const fetchImpl = github({
      "POST https://github.com/login/device/code": deviceCode,
      [GITHUB_REVOKE]: {},
    });
    await startCliConnectorSignIn({
      account_id: accountId,
      connector: "github",
    });
    expect(revokes(fetchImpl)).toEqual([
      expect.stringContaining('"access_token":"ghu_orphan"'),
    ]);
    expect(revokeMock).toHaveBeenCalledWith({
      id: connectionId,
      owner_account_id: accountId,
    });
  });

  it("ignores a client-supplied time or fetch in the request", async () => {
    const { pollCliConnectorSignIn } = await import("./cli-connectors");
    pendingSignIn("github", { next_poll_at: NOW + 5000 });
    const fetchImpl = github({ [GITHUB_TOKEN_URL]: githubTokens });
    const other = jest.fn();
    await expect(
      pollCliConnectorSignIn({
        account_id: accountId,
        connector: "github",
        login_id: connectionId,
        // Extra keys reach the hub unchanged; they must have no effect.
        now: NOW + 1e9,
        fetchImpl: other,
      } as any),
    ).resolves.toEqual({ status: "pending" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
  });

  it("a failing provider poll still uses up its interval", async () => {
    pendingSignIn("github");
    const fetchImpl = github({ [GITHUB_TOKEN_URL]: { status: 502 } });
    await expect(poll("github", fetchImpl)).rejects.toThrow("HTTP 502");
    await expect(poll("github", fetchImpl)).resolves.toEqual({
      status: "pending",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(signInRow!.payload).next_poll_at).toBe(NOW + 5000);
  });

  it("refuses a new sign-in before asking GitHub when too many are pending", async () => {
    const { startCliConnectorSignIn } = await import("./cli-connectors");
    listMock.mockResolvedValue([]);
    createMock.mockRejectedValue(
      Error("at most 3 active credentials are allowed"),
    );
    const fetchImpl = github({});
    await expect(
      startCliConnectorSignIn({ account_id: accountId, connector: "github" }),
    ).rejects.toThrow("at most 3");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the tokens, encrypted, when revoking them fails", async () => {
    const { startCliConnectorSignIn } = await import("./cli-connectors");
    pendingSignIn("github");
    let fetchImpl = github({
      [GITHUB_TOKEN_URL]: githubTokens,
      "GET https://api.github.com/user": { message: "Bad credentials" },
      [GITHUB_REVOKE]: { status: 503 },
    });
    await expect(poll("github", fetchImpl)).rejects.toThrow(
      "GitHub did not accept the new sign-in",
    );
    const kept = JSON.parse(signInRow!.payload);
    expect(kept.exchanged.access_token).toBe("ghu_new");
    expect(kept.cleanup_pending).toBe(true);
    expect(revokeMock).not.toHaveBeenCalled();
    // A later attempt confirms the revocation, then removes the sign-in.
    listMock.mockResolvedValue([{ id: connectionId }]);
    createMock.mockRejectedValue(Error("stop after recovery"));
    fetchImpl = github({ [GITHUB_REVOKE]: { status: 204 } });
    await expect(
      startCliConnectorSignIn({ account_id: accountId, connector: "github" }),
    ).rejects.toThrow("stop after recovery");
    expect(revokes(fetchImpl)).toHaveLength(1);
    expect(signInRow!.payload).not.toContain("ghu_new");
    expect(revokeMock).toHaveBeenCalledWith({
      id: connectionId,
      owner_account_id: accountId,
    });
  });

  it("stores an exchanged sign-in even if the site's app changed meanwhile", async () => {
    pendingSignIn("github", {
      exchanged: githubPayload(),
      exchanged_at: NOW - 1000,
    });
    settings.github_connector_client_id = "Iv23other";
    const fetchImpl = github({
      "GET https://api.github.com/user": { login: "octocat" },
    });
    await expect(poll("github", fetchImpl)).resolves.toEqual(
      expect.objectContaining({ status: "connected" }),
    );
  });

  it("cannot revoke with another app's secret, so it keeps the tokens", async () => {
    pendingSignIn("github", {
      exchanged: githubPayload(),
      exchanged_at: NOW - 1000,
    });
    settings.github_connector_client_id = "Iv23other";
    const fetchImpl = github({
      "GET https://api.github.com/user": { message: "Bad credentials" },
    });
    await expect(poll("github", fetchImpl)).rejects.toThrow();
    expect(revokes(fetchImpl)).toEqual([]);
    expect(JSON.parse(signInRow!.payload)).toEqual(
      expect.objectContaining({ cleanup_pending: true }),
    );
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it("refuses and revokes tokens that live longer than GitHub's maximum", async () => {
    pendingSignIn("github");
    const fetchImpl = github({
      [GITHUB_TOKEN_URL]: { ...githubTokens, expires_in: 9 * 3600 },
      [GITHUB_REVOKE]: {},
    });
    await expect(poll("github", fetchImpl)).rejects.toThrow(
      "longer than allowed",
    );
    expect(revokes(fetchImpl)).toHaveLength(1);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("keeps rejected tokens for a later attempt when revoking them fails", async () => {
    pendingSignIn("github");
    const fetchImpl = github({
      [GITHUB_TOKEN_URL]: { ...githubTokens, expires_in: 9 * 3600 },
      [GITHUB_REVOKE]: { status: 503 },
    });
    await expect(poll("github", fetchImpl)).rejects.toThrow(
      "longer than allowed",
    );
    expect(revokes(fetchImpl)).toHaveLength(1);
    const rescue = createMock.mock.calls.at(-1)![0];
    expect(rescue.selector.kind).toBe("github-token-cleanup");
    expect(JSON.parse(rescue.payload).tokens.refresh_token).toBe("ghr_new");
  });

  it("stores a description without control characters", async () => {
    pendingSignIn("cloudflare");
    github({
      [CF_TOKEN_URL]: cfTokens,
      "GET https://api.cloudflare.com/client/v4/user": {
        success: true,
        result: { email: "me@ex\u202eample.com\n[CLI connectors]" },
      },
    });
    const result: any = await complete();
    expect(result.connection.description).toBe(
      "me@example.comCLI connectors (Workers & sites, R2 storage)",
    );
  });

  it("keeps unrecorded tokens in a rescue record when revoking them fails", async () => {
    pendingSignIn("github");
    const store = lockedMock.getMockImplementation()!;
    lockedMock.mockImplementation(async (opts) =>
      store({
        ...opts,
        update: async (row) => {
          const next = await opts.update(row);
          if (next?.payload.includes('"exchanged"')) {
            throw Error("database unavailable");
          }
          return next;
        },
      }),
    );
    const fetchImpl = github({
      [GITHUB_TOKEN_URL]: githubTokens,
      [GITHUB_REVOKE]: { status: 503 },
    });
    await expect(poll("github", fetchImpl)).rejects.toThrow(
      "database unavailable",
    );
    expect(revokes(fetchImpl)).toHaveLength(1);
    const rescue = createMock.mock.calls.at(-1)![0];
    // A kind of its own that no lease sweep removes.
    expect(rescue.selector.kind).toBe("github-token-cleanup");
    expect(rescue.maxActive).toBeUndefined();
    expect(rescue.metadata.lease_expires_at).toBeUndefined();
    expect(JSON.parse(rescue.payload).tokens).toEqual(
      expect.objectContaining({
        client_id: "Iv23test",
        access_token: "ghu_new",
        refresh_token: "ghr_new",
      }),
    );
  });

  it("renews the cleanup lease after every failed revocation", async () => {
    const { startCliConnectorSignIn } = await import("./cli-connectors");
    pendingSignIn("github", {
      exchanged: githubPayload(),
      exchanged_at: NOW - 300 * 86_400_000,
      cleanup_pending: true,
    });
    signInRow!.metadata = {
      lease_expires_at: new Date(NOW - 1000).toISOString(),
    };
    listMock.mockResolvedValue([{ id: connectionId }]);
    const reserved = jest.fn();
    createMock.mockImplementation(async (opts) => {
      reserved(opts);
      throw Error("stop after recovery");
    });
    const fetchImpl = github({ [GITHUB_REVOKE]: { status: 503 } });
    await expect(
      startCliConnectorSignIn({ account_id: accountId, connector: "github" }),
    ).rejects.toThrow("stop after recovery");
    expect(revokes(fetchImpl)).toHaveLength(1);
    // Renewed before the new reservation's lease sweep could drop it.
    expect(lockedMock.mock.invocationCallOrder.at(-1)).toBeLessThan(
      reserved.mock.invocationCallOrder[0],
    );
    expect(Date.parse(signInRow!.metadata.lease_expires_at)).toBeGreaterThan(
      NOW + 199 * 86_400_000,
    );
    expect(JSON.parse(signInRow!.payload).exchanged.access_token).toBe(
      "ghu_access",
    );
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it("limits how many sign-ins a site's GitHub App is asked to start", async () => {
    const { startCliConnectorSignIn } = await import("./cli-connectors");
    listMock.mockResolvedValue([]);
    const fetchImpl = github({
      "POST https://github.com/login/device/code": {
        device_code: "d",
        user_code: "U",
        verification_uri: "https://github.com/login/device",
      },
    });
    for (let i = 0; i < 30; i++) {
      await startCliConnectorSignIn({
        account_id: accountId,
        connector: "github",
      });
    }
    await expect(
      startCliConnectorSignIn({ account_id: accountId, connector: "github" }),
    ).rejects.toThrow("Too many sign-ins");
    expect(fetchImpl).toHaveBeenCalledTimes(30);
  });

  it("an expired or another account's sign-in gives nothing", async () => {
    const fetchImpl = github({});
    await expect(poll("github", fetchImpl)).resolves.toEqual({
      status: "expired",
    });
    expect(lockedMock.mock.calls[0][0].selector.owner_account_id).toBe(
      accountId,
    );
    pendingSignIn("github", { expires_at: NOW - 1 });
    await expect(poll("github", fetchImpl)).resolves.toEqual({
      status: "expired",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });
});

const CF_BASIC = `Basic ${Buffer.from("cf-client:cf-secret").toString("base64")}`;

describe("signing in to Cloudflare", () => {
  it("sends the user to Cloudflare with only the chosen scopes, and PKCE", async () => {
    const { startCliConnectorSignIn } = await import("./cli-connectors");
    listMock.mockResolvedValue([]);
    const fetchImpl = github({});
    const started: any = await startCliConnectorSignIn({
      account_id: accountId,
      session_hash: "s",
      connector: "cloudflare",
      presets: ["r2"],
    });
    expect(freshAuthMock).toHaveBeenCalled();
    // Nothing is asked of Cloudflare until the user returns.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(started.kind).toBe("redirect");
    const url = new URL(started.authorize_url);
    expect(url.origin + url.pathname).toBe(
      "https://dash.cloudflare.com/oauth2/auth",
    );
    const q = Object.fromEntries(url.searchParams);
    expect(q).toEqual(
      expect.objectContaining({
        response_type: "code",
        client_id: "cf-client",
        redirect_uri: "https://cocalc.test/settings/connectors",
        code_challenge_method: "S256",
      }),
    );
    expect(q.scope.split(" ").sort()).toEqual(
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
    const stored = JSON.parse(signInRow!.payload);
    expect(q.state).toBe(`cocalc-cf.${connectionId}.${stored.nonce}`);
    expect(q.code_challenge).toBe(
      require("node:crypto")
        .createHash("sha256")
        .update(stored.code_verifier)
        .digest("base64url"),
    );
    expect(createMock.mock.calls[0][0].selector).toEqual(
      expect.objectContaining({
        provider: "cloudflare",
        kind: "cloudflare-oauth-login",
      }),
    );
  });

  it("needs a known preset, and the site's own OAuth client", async () => {
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
    settings.cloudflare_connector_client_secret = "";
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

  it("exchanges the code as the site's client and stores the connection", async () => {
    pendingSignIn("cloudflare");
    const fetchImpl = github({
      [CF_TOKEN_URL]: cfTokens,
      "GET https://api.cloudflare.com/client/v4/user": {
        success: true,
        result: { email: "me@example.com" },
      },
    });
    await expect(complete()).resolves.toEqual({
      status: "connected",
      connection: expect.objectContaining({
        connector: "cloudflare",
        description: "me@example.com (Workers & sites, R2 storage)",
      }),
    });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers.authorization).toBe(CF_BASIC);
    expect(Object.fromEntries(new URLSearchParams(init.body))).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: "https://cocalc.test/settings/connectors",
      code_verifier: "verifier-1",
    });
    const saved = createMock.mock.calls[0][0];
    expect(saved.selector.kind).toBe("cloudflare-cli-connection");
    expect(JSON.parse(saved.payload)).toEqual(
      expect.objectContaining({
        type: "cloudflare-oauth",
        client_id: "cf-client",
        presets: ["workers", "r2"],
        refresh_token: "cf-refresh",
      }),
    );
    expect(revokeMock).toHaveBeenCalled();
    // The same redirect cannot be used again.
    fetchImpl.mockClear();
    signInRow = undefined;
    await expect(complete()).resolves.toEqual({ status: "expired" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a state with the wrong nonce or malformed, without asking Cloudflare", async () => {
    pendingSignIn("cloudflare");
    const fetchImpl = github({});
    await expect(
      complete(`cocalc-cf.${connectionId}.nonce-2`),
    ).resolves.toEqual({ status: "expired" });
    for (const state of ["", "x", `cocalc-cf.${connectionId}`, "a.b.c.d"]) {
      await expect(complete(state)).rejects.toThrow("invalid sign-in response");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
    // The sign-in is still there for the real redirect.
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it("only looks up this account's sign-ins", async () => {
    pendingSignIn("cloudflare");
    github({ [CF_TOKEN_URL]: { error: "invalid_grant" } });
    await complete();
    expect(lockedMock.mock.calls[0][0].selector).toEqual(
      expect.objectContaining({
        owner_account_id: accountId,
        kind: "cloudflare-oauth-login",
      }),
    );
  });

  it("a completion already under way asks Cloudflare nothing more", async () => {
    pendingSignIn("cloudflare", { claim: "other", claim_at: NOW - 1000 });
    const fetchImpl = github({});
    await expect(complete()).resolves.toEqual({ status: "pending" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a claim left by a stopped hub expires", async () => {
    pendingSignIn("cloudflare", { claim: "other", claim_at: NOW - 61_000 });
    const fetchImpl = github({ [CF_TOKEN_URL]: { error: "invalid_grant" } });
    await expect(complete()).resolves.toEqual({ status: "expired" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("when the site's budget is used up, releases the claim for a retry", async () => {
    github({ [CF_TOKEN_URL]: { error: "invalid_grant" } });
    for (let i = 0; i < 30; i++) {
      pendingSignIn("cloudflare");
      await complete();
    }
    pendingSignIn("cloudflare");
    const fetchImpl = github({ [CF_TOKEN_URL]: cfTokens });
    await expect(complete()).resolves.toEqual({
      status: "pending",
      slow_down: true,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.parse(signInRow!.payload).claim).toBeUndefined();
  });

  it("an expired or reused code ends the sign-in", async () => {
    pendingSignIn("cloudflare");
    github({ [CF_TOKEN_URL]: { error: "invalid_grant" } });
    await expect(complete()).resolves.toEqual({ status: "expired" });
    expect(revokeMock).toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "Cloudflare will not say who it is",
      () => undefined,
      { success: false },
      "Cloudflare did not accept the new sign-in",
    ],
    [
      "the connection cannot be stored",
      () =>
        createMock.mockRejectedValue(
          Error("at most 10 active credentials are allowed"),
        ),
      { success: true, result: { email: "me@example.com" } },
      "at most 10",
    ],
  ])("revokes both new tokens when %s", async (_, arrange, user, error) => {
    pendingSignIn("cloudflare");
    arrange();
    const fetchImpl = github({
      [CF_TOKEN_URL]: cfTokens,
      "GET https://api.cloudflare.com/client/v4/user": user,
      [CF_REVOKE]: {},
    });
    await expect(complete()).rejects.toThrow(error);
    const calls = fetchImpl.mock.calls.filter(([url]) =>
      `${url}`.endsWith("/oauth2/revoke"),
    );
    expect(calls.map(([, init]) => init.headers.authorization)).toEqual([
      CF_BASIC,
      CF_BASIC,
    ]);
    expect(
      calls.map(([, init]) =>
        Object.fromEntries(new URLSearchParams(init.body)),
      ),
    ).toEqual([
      { token: "cf-refresh", token_type_hint: "refresh_token" },
      { token: "cf-access", token_type_hint: "access_token" },
    ]);
    expect(signInRow!.payload).not.toContain("cf-refresh");
  });

  it("GitHub and Cloudflare sign-ins cannot finish as each other", async () => {
    pendingSignIn("github");
    const fetchImpl = github({});
    await expect(complete()).resolves.toEqual({ status: "expired" });
    pendingSignIn("cloudflare");
    // A Cloudflare sign-in is never polled at the provider.
    await expect(poll("cloudflare", fetchImpl)).resolves.toEqual({
      status: "pending",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
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

  it("cannot turn on a connection that is being disconnected", async () => {
    const { saveCliConnectorGrant } = await import("./cli-connectors");
    getByIdMock.mockResolvedValue({
      ...connection,
      metadata: { disconnecting: true },
    });
    await expect(
      saveCliConnectorGrant({
        ...base,
        enabled: true,
        connection_id: connectionId,
      }),
    ).rejects.toThrow("connection is unavailable");
  });

  it("a grant saved while a disconnect started turns itself off", async () => {
    const { saveCliConnectorGrant } = await import("./cli-connectors");
    getByIdMock
      .mockResolvedValueOnce(connection)
      .mockResolvedValueOnce({
        ...connection,
        metadata: { disconnecting: true },
      });
    await expect(
      saveCliConnectorGrant({
        ...base,
        enabled: true,
        connection_id: connectionId,
      }),
    ).rejects.toThrow("connection is unavailable");
    const [sql, params] = queryMock.mock.calls.at(-1)!;
    expect(sql).toMatch(/SET enabled=false/);
    expect(params).toEqual([grant.grant_id, connectionId]);
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
    const tokens = await issueCliConnectorTurnTokens(request);
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
    await expect(issueCliConnectorTurnTokens(request)).resolves.toEqual([]);
    expect(connection.metadata.needs_reconnect).toBe(true);
    // And it is not retried on later turns.
    fetchImpl.mockClear();
    await issueCliConnectorTurnTokens(request);
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
        client_id: "cf-client",
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
    const tokens = await issueCliConnectorTurnTokens(request);
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

  it("keeps rotated tokens it rejects when revoking them fails", async () => {
    const { issueCliConnectorTurnTokens } = await import("./cli-connectors");
    connection.payload = JSON.stringify(githubPayload(NOW + 60_000));
    const fetchImpl = github({
      [GITHUB_TOKEN_URL]: { ...githubTokens, expires_in: 9 * 3600 },
      [GITHUB_REVOKE]: { status: 503 },
    });
    await expect(issueCliConnectorTurnTokens(request)).resolves.toEqual([]);
    expect(revokes(fetchImpl)).toHaveLength(1);
    expect(connection.metadata.needs_reconnect).toBe(true);
    const rescue = createMock.mock.calls.at(-1)![0];
    expect(rescue.selector.kind).toBe("github-token-cleanup");
    expect(JSON.parse(rescue.payload).tokens.access_token).toBe("ghu_new");
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
  it("revokes the tokens as they are when marked, not a stale read", async () => {
    const { disconnectCliConnection } = await import("./cli-connectors");
    // The first read is stale: a turn rotated the tokens meanwhile.
    const stale = { ...connection, payload: JSON.stringify(githubPayload()) };
    connection = {
      ...connection,
      payload: JSON.stringify({
        ...githubPayload(),
        access_token: "ghu_rotated",
      }),
    };
    getByIdMock.mockImplementation(async ({ selector }) =>
      selector.kind === "github-cli-connection" ? stale : undefined,
    );
    const fetchImpl = github({ [GITHUB_REVOKE]: { status: 204 } });
    await disconnectCliConnection({
      account_id: accountId,
      connection_id: connectionId,
    });
    expect(revokes(fetchImpl)).toEqual([
      expect.stringContaining('"access_token":"ghu_rotated"'),
    ]);
    expect(connection.metadata.disconnecting).toBe(true);
    // Marked before the grants go off, so no later refresh rotates them.
    const grantsOff = queryMock.mock.calls.findIndex(([q]) =>
      /UPDATE agent_connector_grants/.test(q),
    );
    expect(lockedMock.mock.invocationCallOrder[0]).toBeLessThan(
      queryMock.mock.invocationCallOrder[grantsOff],
    );
  });

  it("a connection whose revocation failed is hidden, unused, and retried", async () => {
    const {
      listCliConnections,
      issueCliConnectorTurnTokens,
      startCliConnectorSignIn,
    } = await import("./cli-connectors");
    connection.metadata = { description: "@octo", disconnecting: true };
    listMock.mockImplementation(async ({ kind }) =>
      kind === "github-cli-connection"
        ? [
            {
              id: connectionId,
              metadata: connection.metadata,
              created: new Date(),
            },
          ]
        : [],
    );
    await expect(
      listCliConnections({ account_id: accountId }),
    ).resolves.toEqual([]);
    await expect(
      issueCliConnectorTurnTokens({
        account_id: accountId,
        host_id: hostId,
        agent_id: agentId,
        source_project_id: projectId,
        run_id: runId,
        turn_ref,
      }),
    ).resolves.toEqual([]);
    const fetchImpl = github({
      [GITHUB_REVOKE]: { status: 204 },
      "POST https://github.com/login/device/code": {
        device_code: "d",
        user_code: "U",
        verification_uri: "https://github.com/login/device",
      },
    });
    await startCliConnectorSignIn({
      account_id: accountId,
      connector: "github",
    });
    expect(revokes(fetchImpl)).toHaveLength(1);
    expect(revokeMock).toHaveBeenCalledWith({
      id: connectionId,
      owner_account_id: accountId,
    });
  });

  it("revokes both Cloudflare tokens, or keeps them for a later attempt", async () => {
    const { disconnectCliConnection } = await import("./cli-connectors");
    const cfConnection = {
      id: connectionId,
      payload: JSON.stringify({
        version: 2,
        type: "cloudflare-oauth",
        client_id: "cf-client",
        presets: ["r2"],
        access_token: "cf-access",
        access_expires_at: NOW + HOUR,
        refresh_token: "cf-refresh",
      }),
      metadata: {},
    };
    connection = cfConnection;
    getByIdMock.mockImplementation(async ({ selector }) =>
      selector.kind === "cloudflare-cli-connection" ? connection : undefined,
    );
    let fetchImpl = github({ [CF_REVOKE]: {} });
    await disconnectCliConnection({
      account_id: accountId,
      connection_id: connectionId,
    });
    expect(
      fetchImpl.mock.calls.map(([, init]) =>
        new URLSearchParams(init.body).get("token"),
      ),
    ).toEqual(["cf-refresh", "cf-access"]);
    expect(revokeMock).toHaveBeenCalledTimes(1);
    // Revocation fails: the original record stays, cleanup only.
    connection = { ...cfConnection, metadata: {} };
    revokeMock.mockClear();
    fetchImpl = github({ [CF_REVOKE]: { status: 503 } });
    await disconnectCliConnection({
      account_id: accountId,
      connection_id: connectionId,
    });
    expect(revokeMock).not.toHaveBeenCalled();
    expect(connection.metadata.disconnecting).toBe(true);
    expect(JSON.parse(connection.payload).refresh_token).toBe("cf-refresh");
  });

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
