const createLogger = () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  extend: jest.fn(() => createLogger()),
});

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => createLogger(),
  getLogger: () => createLogger(),
}));

jest.mock("@cocalc/project/logger", () => ({
  __esModule: true,
  default: () => createLogger(),
  getLogger: () => createLogger(),
}));

describe("buildCodexRuntimeEnv", () => {
  const prevBearer = process.env.COCALC_BEARER_TOKEN;
  const prevAgent = process.env.COCALC_AGENT_TOKEN;
  const prevApi = process.env.COCALC_API_URL;
  const prevPort = process.env.PORT;
  const prevHubPort = process.env.HUB_PORT;

  beforeEach(() => {
    jest.resetModules();
    delete process.env.COCALC_BEARER_TOKEN;
    delete process.env.COCALC_AGENT_TOKEN;
    delete process.env.COCALC_API_URL;
    delete process.env.PORT;
    delete process.env.HUB_PORT;
  });

  afterAll(() => {
    if (prevBearer == null) delete process.env.COCALC_BEARER_TOKEN;
    else process.env.COCALC_BEARER_TOKEN = prevBearer;
    if (prevAgent == null) delete process.env.COCALC_AGENT_TOKEN;
    else process.env.COCALC_AGENT_TOKEN = prevAgent;
    if (prevApi == null) delete process.env.COCALC_API_URL;
    else process.env.COCALC_API_URL = prevApi;
    if (prevPort == null) delete process.env.PORT;
    else process.env.PORT = prevPort;
    if (prevHubPort == null) delete process.env.HUB_PORT;
    else process.env.HUB_PORT = prevHubPort;
  });

  it("prefers an existing bearer token without calling host token issuance", async () => {
    process.env.COCALC_BEARER_TOKEN = "existing-bearer";
    const { hubApi } = await import("../../api");
    const { buildCodexRuntimeEnv } = await import("../runtime-env");
    const issueToken = jest.fn();
    (hubApi as any).hosts = {
      issueProjectHostAgentAuthToken: issueToken,
    };

    const env = await buildCodexRuntimeEnv({
      request: {
        account_id: "00000000-1000-4000-8000-000000000001",
        prompt: "test",
      } as any,
      projectId: "00000000-1000-4000-8000-000000000002",
      includeCliBin: false,
      useContainer: true,
    });

    expect(env.COCALC_BEARER_TOKEN).toBe("existing-bearer");
    expect(env.COCALC_AGENT_TOKEN).toBe("existing-bearer");
    expect(issueToken).not.toHaveBeenCalled();
  });

  it("issues a host-scoped agent bearer when none is already present", async () => {
    const { hubApi } = await import("../../api");
    const { buildCodexRuntimeEnv } = await import("../runtime-env");
    const issueToken = jest.fn(async () => ({
      host_id: "00000000-1000-4000-8000-000000000123",
      token: "issued-agent-token",
      expires_at: Date.now() + 60_000,
    }));
    (hubApi as any).hosts = {
      issueProjectHostAgentAuthToken: issueToken,
    };

    const env = await buildCodexRuntimeEnv({
      request: {
        account_id: "00000000-1000-4000-8000-000000000001",
        prompt: "test",
        chat: {
          browser_id: "browser-1",
        },
      } as any,
      projectId: "00000000-1000-4000-8000-000000000002",
      includeCliBin: false,
      useContainer: true,
    });

    expect(issueToken).toHaveBeenCalledWith({
      account_id: "00000000-1000-4000-8000-000000000001",
      project_id: "00000000-1000-4000-8000-000000000002",
    });
    expect(env.COCALC_BEARER_TOKEN).toBe("issued-agent-token");
    expect(env.COCALC_AGENT_TOKEN).toBe("issued-agent-token");
    expect(env.COCALC_BROWSER_ID).toBe("browser-1");
  });

  it("does not let request runtime env override scoped CLI auth", async () => {
    const { hubApi } = await import("../../api");
    const { buildCodexRuntimeEnv } = await import("../runtime-env");
    const issueToken = jest.fn(async () => ({
      host_id: "00000000-1000-4000-8000-000000000123",
      token: "issued-agent-token",
      expires_at: Date.now() + 60_000,
    }));
    (hubApi as any).hosts = {
      issueProjectHostAgentAuthToken: issueToken,
    };

    const env = await buildCodexRuntimeEnv({
      request: {
        account_id: "00000000-1000-4000-8000-000000000001",
        prompt: "test",
        runtime_env: {
          COCALC_ACCOUNT_ID: "00000000-1000-4000-8000-000000000999",
          COCALC_PROJECT_ID: "00000000-1000-4000-8000-000000000999",
          COCALC_BEARER_TOKEN: "stale-token",
          COCALC_AGENT_TOKEN: "stale-token",
          COCALC_API_URL: "https://wrong.example",
          FOO: "bar",
        },
        chat: {
          api_url: "https://browser.example",
          browser_id: "browser-1",
        },
      } as any,
      projectId: "00000000-1000-4000-8000-000000000002",
      includeCliBin: false,
      useContainer: false,
    });

    expect(env).toMatchObject({
      COCALC_ACCOUNT_ID: "00000000-1000-4000-8000-000000000001",
      COCALC_PROJECT_ID: "00000000-1000-4000-8000-000000000002",
      COCALC_BROWSER_ID: "browser-1",
      COCALC_API_URL: "https://browser.example",
      COCALC_BEARER_TOKEN: "issued-agent-token",
      COCALC_AGENT_TOKEN: "issued-agent-token",
      FOO: "bar",
    });
  });

  it("can issue a bearer using account id from runtime env", async () => {
    const { hubApi } = await import("../../api");
    const { buildCodexRuntimeEnv } = await import("../runtime-env");
    const issueToken = jest.fn(async () => ({
      host_id: "00000000-1000-4000-8000-000000000123",
      token: "issued-agent-token",
      expires_at: Date.now() + 60_000,
    }));
    (hubApi as any).hosts = {
      issueProjectHostAgentAuthToken: issueToken,
    };

    const env = await buildCodexRuntimeEnv({
      request: {
        account_id: "",
        prompt: "test",
        runtime_env: {
          COCALC_ACCOUNT_ID: "00000000-1000-4000-8000-000000000001",
        },
      } as any,
      projectId: "00000000-1000-4000-8000-000000000002",
      includeCliBin: false,
      useContainer: true,
    });

    expect(issueToken).toHaveBeenCalledWith({
      account_id: "00000000-1000-4000-8000-000000000001",
      project_id: "00000000-1000-4000-8000-000000000002",
    });
    expect(env.COCALC_ACCOUNT_ID).toBe("00000000-1000-4000-8000-000000000001");
    expect(env.COCALC_BEARER_TOKEN).toBe("issued-agent-token");
    expect(env.COCALC_AGENT_TOKEN).toBe("issued-agent-token");
  });
});
