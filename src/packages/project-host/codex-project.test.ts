import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { getCodexProjectSpawner, setCodexProjectSpawner } from "@cocalc/ai/acp";

const spawnMock = jest.fn();
const execFileMock = jest.fn();
const execMock = jest.fn();
const podmanEnvMock = jest.fn(() => ({
  XDG_RUNTIME_DIR: "/tmp/cocalc-podman-runtime",
  CONTAINERS_CGROUP_MANAGER: "cgroupfs",
}));

jest.mock("node:child_process", () => ({
  spawn: (...args) => spawnMock(...args),
  execFile: (...args) => execFileMock(...args),
  exec: (...args) => execMock(...args),
}));

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
  getLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock("@cocalc/backend/podman/env", () => ({
  podmanEnv: () => podmanEnvMock(),
}));

jest.mock("@cocalc/project-runner/run/filesystem", () => ({
  localPath: jest.fn(),
}));

jest.mock("@cocalc/project-runner/run/rootfs", () => ({
  getImageNamePath: jest.fn(),
  mount: jest.fn(),
  unmount: jest.fn(),
}));

jest.mock("@cocalc/project-runner/run/podman", () => ({
  networkArgument: jest.fn(() => "--network=pasta:--map-gw"),
}));

jest.mock("@cocalc/backend/podman", () => ({
  mountArg: jest.fn(),
}));

jest.mock("@cocalc/project-runner/run/env", () => ({
  getEnvironment: jest.fn(),
}));

jest.mock("@cocalc/project-runner/run/mounts", () => ({
  getCoCalcMounts: jest.fn(() => []),
}));

jest.mock("./sqlite/projects", () => ({
  getProject: jest.fn(),
}));

jest.mock("./codex/codex-auth", () => ({
  resolveCodexAuthRuntime: jest.fn(),
  resolveSharedCodexHome: jest.fn(),
  logResolvedCodexAuthRuntime: jest.fn(),
  redactCodexAuthRuntime: jest.fn(() => ({})),
}));

jest.mock("./codex/codex-auth-registry", () => ({
  syncSubscriptionAuthToRegistryIfChanged: jest.fn(),
}));

jest.mock("./last-edited", () => ({
  touchProjectLastEdited: jest.fn(),
}));

jest.mock("@cocalc/lite/hub/api", () => ({
  hubApi: {
    projects: {
      start: jest.fn(),
    },
    hosts: {
      issueProjectHostAgentAuthToken: jest.fn(),
    },
  },
}));

const filesystem = jest.requireMock("@cocalc/project-runner/run/filesystem");
const auth = jest.requireMock("./codex/codex-auth");
const projects = jest.requireMock("./sqlite/projects");
const { hubApi } = jest.requireMock("@cocalc/lite/hub/api");

class FakeProc extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
}

function jwt(payload: Record<string, unknown>): string {
  const enc = (obj: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  return `${enc({ alg: "none", typ: "JWT" })}.${enc(payload)}.sig`;
}

describe("initCodexProjectRunner", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    execFileMock.mockReset();
    execMock.mockReset();
    podmanEnvMock.mockClear();
    delete process.env.COCALC_BIN_PATH;
    delete process.env.COCALC_CLI_BIN;
    delete process.env.COCALC_API_URL;
    delete process.env.BASE_URL;
    delete process.env.MASTER_CONAT_SERVER;
    delete process.env.COCALC_MASTER_CONAT_SERVER;
    delete process.env.COCALC_DANGEROUS_PROJECT_RUNTIME_CLI_CMD_OVERRIDE;
    delete process.env.COCALC_DANGEROUS_PROJECT_RUNTIME_CLI_PATH_OVERRIDE;
    delete process.env.COCALC_DANGEROUS_PROJECT_RUNTIME_CODEX_PATH_OVERRIDE;
    setCodexProjectSpawner(null);
    projects.getProject.mockReturnValue({
      state: "running",
      run_quota: {},
    });
    hubApi.projects.start.mockReset();
    hubApi.projects.start.mockResolvedValue({});
    hubApi.hosts.issueProjectHostAgentAuthToken.mockReset();
    hubApi.hosts.issueProjectHostAgentAuthToken.mockResolvedValue({
      token: "issued-project-host-token",
    });
  });

  afterEach(() => {
    setCodexProjectSpawner(null);
  });

  it("uses authenticated real-project app-server exec", async () => {
    spawnMock.mockReturnValue(new FakeProc());
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      if (args[0] === "inspect" && args[1] === "-f") {
        cb(null, "true\n", "");
        return;
      }
      cb(null, "", "");
    });
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-project-test-"));
    const bin = path.join(tmp, "bin");
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, "codex"), "");
    await fs.writeFile(path.join(bin, "cocalc"), "");
    const home = path.join(tmp, "home");
    await fs.mkdir(home, { recursive: true });
    const imageFile = path.join(tmp, "image-name.txt");
    await fs.writeFile(imageFile, "buildpack-deps:noble-scm\n");
    filesystem.localPath.mockResolvedValue({ home, scratch: undefined });
    auth.resolveCodexAuthRuntime.mockResolvedValue({
      source: "account-api-key",
      contextId: "acct-key-1234",
      env: { OPENAI_API_KEY: "secret-key" },
    });
    process.env.COCALC_BIN_PATH = bin;

    const { initCodexProjectRunner } = await import("./codex/codex-project");
    initCodexProjectRunner();
    const spawner = getCodexProjectSpawner();
    expect(spawner?.spawnCodexAppServer).toBeDefined();

    const spawned = await spawner!.spawnCodexAppServer!({
      projectId: "6bc2c387-4c80-4a79-aa68-65d8e68a6a52",
      accountId: "00000000-0000-4000-8000-000000000001",
      cwd: "/root",
      env: {
        FOO: "bar",
        COCALC_API_URL: "http://localhost:7103",
      },
    });

    expect(podmanEnvMock).toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnMock.mock.calls[0];
    expect(command).toBe("podman");
    expect(args).toEqual(
      expect.arrayContaining([
        "exec",
        "-i",
        "-u",
        "1000:1000",
        "--workdir",
        "/home/user",
        "-e",
        "HOME=/home/user",
        "-e",
        "USER=user",
        "-e",
        "LOGNAME=user",
        "-e",
        "COCALC_BEARER_TOKEN=issued-project-host-token",
        "-e",
        "COCALC_AGENT_TOKEN=issued-project-host-token",
        "-e",
        "FOO=bar",
        "-e",
        "COCALC_API_URL=http://host.containers.internal:7103",
        "project-6bc2c387-4c80-4a79-aa68-65d8e68a6a52",
        "/opt/cocalc/bin2/codex",
        "--config",
        'cli_auth_credentials_store="ephemeral"',
        "app-server",
        "--listen",
        "stdio://",
      ]),
    );
    expect(args).not.toContain("OPENAI_API_KEY=secret-key");
    expect(options).toMatchObject({
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        XDG_RUNTIME_DIR: "/tmp/cocalc-podman-runtime",
        CONTAINERS_CGROUP_MANAGER: "cgroupfs",
      },
    });
    expect(spawned.authSource).toBe("account-api-key");
    expect(spawned.runtimeEnv).toMatchObject({
      COCALC_API_URL: "http://host.containers.internal:7103",
      COCALC_BEARER_TOKEN: "issued-project-host-token",
      COCALC_AGENT_TOKEN: "issued-project-host-token",
      COCALC_ACCOUNT_ID: "00000000-0000-4000-8000-000000000001",
    });
    expect(spawned.appServerLogin).toEqual({
      type: "apiKey",
      apiKey: "secret-key",
    });
    expect(hubApi.hosts.issueProjectHostAgentAuthToken).toHaveBeenCalledWith({
      account_id: "00000000-0000-4000-8000-000000000001",
      project_id: "6bc2c387-4c80-4a79-aa68-65d8e68a6a52",
    });
    expect(spawned.containerPathMap).toEqual({
      rootHostPath: home,
      scratchHostPath: undefined,
    });
  });

  it("falls back to the bundled project runtime cocalc command when no host cli is resolvable", async () => {
    spawnMock.mockReturnValue(new FakeProc());
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      if (args[0] === "inspect" && args[1] === "-f") {
        cb(null, "true\n", "");
        return;
      }
      cb(null, "", "");
    });
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-project-test-"));
    const bin = path.join(tmp, "bin");
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, "codex"), "");
    const home = path.join(tmp, "home");
    await fs.mkdir(home, { recursive: true });
    const imageFile = path.join(tmp, "image-name.txt");
    await fs.writeFile(imageFile, "buildpack-deps:noble-scm\n");
    filesystem.localPath.mockResolvedValue({ home, scratch: undefined });
    auth.resolveCodexAuthRuntime.mockResolvedValue({
      source: "account-api-key",
      contextId: "acct-key-1234",
      env: { OPENAI_API_KEY: "secret-key" },
    });
    process.env.COCALC_BIN_PATH = bin;
    const originalPath = process.env.PATH;
    process.env.PATH = bin;

    const { initCodexProjectRunner } = await import("./codex/codex-project");
    try {
      initCodexProjectRunner();
      const spawner = getCodexProjectSpawner();
      expect(spawner?.spawnCodexAppServer).toBeDefined();

      const spawned = await spawner!.spawnCodexAppServer!({
        projectId: "6bc2c387-4c80-4a79-aa68-65d8e68a6a52",
        accountId: "00000000-0000-4000-8000-000000000001",
        cwd: "/root",
        env: {
          FOO: "bar",
        },
      });

      const [, args] = spawnMock.mock.calls[0];
      expect(args).toEqual(
        expect.arrayContaining([
          "-e",
          "COCALC_CLI_BIN=/opt/cocalc/bin2/cocalc",
          "-e",
          'COCALC_CLI_CMD="/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js"',
        ]),
      );
      expect(spawned.runtimeEnv).toMatchObject({
        COCALC_CLI_BIN: "/opt/cocalc/bin2/cocalc",
        COCALC_CLI_CMD:
          '"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js"',
        COCALC_ACCOUNT_ID: "00000000-0000-4000-8000-000000000001",
      });
      const pathEnv = args.find((value) => `${value}`.startsWith("PATH="));
      expect(pathEnv).toContain("/usr/bin");
      expect(pathEnv).toContain("/bin");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("prefers the host-local api url over the browser origin in project runtimes", async () => {
    spawnMock.mockReturnValue(new FakeProc());
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      if (args[0] === "inspect" && args[1] === "-f") {
        cb(null, "true\n", "");
        return;
      }
      cb(null, "", "");
    });
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-project-test-"));
    const bin = path.join(tmp, "bin");
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, "codex"), "");
    const home = path.join(tmp, "home");
    await fs.mkdir(home, { recursive: true });
    const imageFile = path.join(tmp, "image-name.txt");
    await fs.writeFile(imageFile, "buildpack-deps:noble-scm\n");
    filesystem.localPath.mockResolvedValue({ home, scratch: undefined });
    auth.resolveCodexAuthRuntime.mockResolvedValue({
      source: "account-api-key",
      contextId: "acct-key-1234",
      env: { OPENAI_API_KEY: "secret-key" },
    });
    process.env.COCALC_BIN_PATH = bin;
    process.env.COCALC_API_URL = "http://localhost:7103";

    const { initCodexProjectRunner } = await import("./codex/codex-project");
    initCodexProjectRunner();
    const spawner = getCodexProjectSpawner();

    const spawned = await spawner!.spawnCodexAppServer!({
      projectId: "6bc2c387-4c80-4a79-aa68-65d8e68a6a52",
      accountId: "00000000-0000-4000-8000-000000000001",
      cwd: "/root",
      env: {
        COCALC_API_URL: "https://lite3.cocalc.ai",
      },
    });

    expect(spawned.runtimeEnv).toMatchObject({
      COCALC_API_URL: "http://host.containers.internal:7103",
    });
  });

  it("ignores host cli wrappers and keeps the project runtime cli command", async () => {
    spawnMock.mockReturnValue(new FakeProc());
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      if (args[0] === "inspect" && args[1] === "-f") {
        cb(null, "true\n", "");
        return;
      }
      cb(null, "", "");
    });
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-project-test-"));
    const bin = path.join(tmp, "bin");
    const cliDir = path.join(tmp, "cli");
    await fs.mkdir(bin, { recursive: true });
    await fs.mkdir(cliDir, { recursive: true });
    await fs.writeFile(path.join(bin, "codex"), "");
    await fs.writeFile(path.join(cliDir, "cocalc.js"), "");
    const home = path.join(tmp, "home");
    await fs.mkdir(home, { recursive: true });
    const imageFile = path.join(tmp, "image-name.txt");
    await fs.writeFile(imageFile, "buildpack-deps:noble-scm\n");
    filesystem.localPath.mockResolvedValue({ home, scratch: undefined });
    auth.resolveCodexAuthRuntime.mockResolvedValue({
      source: "account-api-key",
      contextId: "acct-key-1234",
      env: { OPENAI_API_KEY: "secret-key" },
    });
    process.env.COCALC_BIN_PATH = bin;
    process.env.COCALC_CLI_BIN = path.join(cliDir, "cocalc.js");
    process.env.PATH = `${cliDir}:${process.env.PATH ?? ""}`;

    const { initCodexProjectRunner } = await import("./codex/codex-project");
    initCodexProjectRunner();
    const spawner = getCodexProjectSpawner();

    await spawner!.spawnCodexAppServer!({
      projectId: "6bc2c387-4c80-4a79-aa68-65d8e68a6a52",
      accountId: "00000000-0000-4000-8000-000000000001",
      cwd: "/root",
      env: {},
    });

    const [, args] = spawnMock.mock.calls[0];
    const envVars: string[] = [];
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-e") envVars.push(`${args[i + 1]}`);
    }
    expect(envVars).toEqual(
      expect.arrayContaining([
        "COCALC_CLI_BIN=/opt/cocalc/bin2/cocalc",
        'COCALC_CLI_CMD="/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js"',
      ]),
    );
    const pathEnv = envVars.find((value) => value.startsWith("PATH="));
    expect(pathEnv).toContain("/usr/bin");
    expect(pathEnv).toContain("/bin");
  });

  it("seeds app-server ChatGPT auth from host auth.json without mounting it", async () => {
    spawnMock.mockReturnValue(new FakeProc());
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      if (args[0] === "inspect" && args[1] === "-f") {
        cb(null, "true\n", "");
        return;
      }
      cb(null, "", "");
    });
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-project-test-"));
    const home = path.join(tmp, "home");
    await fs.mkdir(home, { recursive: true });
    const codexHome = path.join(tmp, "subscription-home");
    await fs.mkdir(codexHome, { recursive: true });
    const accessToken = jwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "workspace-123",
        chatgpt_plan_type: "pro",
      },
    });
    await fs.writeFile(
      path.join(codexHome, "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: accessToken,
          account_id: "workspace-123",
        },
      }),
    );
    filesystem.localPath.mockResolvedValue({ home, scratch: undefined });
    auth.resolveCodexAuthRuntime.mockResolvedValue({
      source: "subscription",
      contextId: "subscription-1234",
      codexHome,
      env: {},
    });

    const { initCodexProjectRunner } = await import("./codex/codex-project");
    initCodexProjectRunner();
    const spawner = getCodexProjectSpawner();
    const spawned = await spawner!.spawnCodexAppServer!({
      projectId: "6bc2c387-4c80-4a79-aa68-65d8e68a6a52",
      accountId: "00000000-0000-4000-8000-000000000001",
      cwd: "/root",
    });

    expect(spawned.authSource).toBe("subscription");
    expect(spawned.appServerLogin).toEqual({
      type: "chatgptAuthTokens",
      accessToken,
      chatgptAccountId: "workspace-123",
      chatgptPlanType: "pro",
    });
    expect(spawnMock.mock.calls[0][1]).toContain(
      'cli_auth_credentials_store="ephemeral"',
    );
    await expect(
      spawned.handleAppServerRequest?.({
        id: 17,
        method: "account/chatgptAuthTokens/refresh",
        params: {
          reason: "unauthorized",
          previousAccountId: "workspace-123",
        },
      }),
    ).resolves.toEqual({
      accessToken,
      chatgptAccountId: "workspace-123",
      chatgptPlanType: "pro",
    });
    expect(spawnMock.mock.calls[0][1]).not.toContain(
      "OPENAI_API_KEY=secret-key",
    );
  });

  it("re-reads the latest host auth.json on app-server token refresh", async () => {
    spawnMock.mockReturnValue(new FakeProc());
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      if (args[0] === "inspect" && args[1] === "-f") {
        cb(null, "true\n", "");
        return;
      }
      cb(null, "", "");
    });
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-project-test-"));
    const home = path.join(tmp, "home");
    await fs.mkdir(home, { recursive: true });
    const codexHome = path.join(tmp, "subscription-home");
    await fs.mkdir(codexHome, { recursive: true });
    const initialAccessToken = jwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "workspace-123",
        chatgpt_plan_type: "pro",
      },
      token_version: "initial",
    });
    const refreshedAccessToken = jwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "workspace-123",
        chatgpt_plan_type: "pro",
      },
      token_version: "refreshed",
    });
    const authPath = path.join(codexHome, "auth.json");
    await fs.writeFile(
      authPath,
      JSON.stringify({
        tokens: {
          access_token: initialAccessToken,
          account_id: "workspace-123",
        },
      }),
    );
    filesystem.localPath.mockResolvedValue({ home, scratch: undefined });
    auth.resolveCodexAuthRuntime.mockResolvedValue({
      source: "subscription",
      contextId: "subscription-1234",
      codexHome,
      env: {},
    });

    const { initCodexProjectRunner } = await import("./codex/codex-project");
    initCodexProjectRunner();
    const spawner = getCodexProjectSpawner();
    const spawned = await spawner!.spawnCodexAppServer!({
      projectId: "6bc2c387-4c80-4a79-aa68-65d8e68a6a52",
      accountId: "00000000-0000-4000-8000-000000000001",
      cwd: "/root",
    });

    expect(spawned.appServerLogin).toEqual({
      type: "chatgptAuthTokens",
      accessToken: initialAccessToken,
      chatgptAccountId: "workspace-123",
      chatgptPlanType: "pro",
    });

    await fs.writeFile(
      authPath,
      JSON.stringify({
        tokens: {
          access_token: refreshedAccessToken,
          account_id: "workspace-123",
        },
      }),
    );

    await expect(
      spawned.handleAppServerRequest?.({
        id: 18,
        method: "account/chatgptAuthTokens/refresh",
        params: {
          reason: "unauthorized",
          previousAccountId: "workspace-123",
        },
      }),
    ).resolves.toEqual({
      accessToken: refreshedAccessToken,
      chatgptAccountId: "workspace-123",
      chatgptPlanType: "pro",
    });
  });

  it("starts the project container before launching app-server when needed", async () => {
    spawnMock.mockReturnValue(new FakeProc());
    let inspectCalls = 0;
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      if (args[0] === "inspect" && args[1] === "-f") {
        inspectCalls += 1;
        cb(null, inspectCalls === 1 ? "false\n" : "true\n", "");
        return;
      }
      cb(null, "", "");
    });
    projects.getProject.mockReturnValue({
      state: "opened",
      run_quota: {},
    });
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-project-test-"));
    const home = path.join(tmp, "home");
    await fs.mkdir(home, { recursive: true });
    filesystem.localPath.mockResolvedValue({ home, scratch: undefined });
    auth.resolveCodexAuthRuntime.mockResolvedValue({
      source: "account-api-key",
      contextId: "acct-key-1234",
      env: { OPENAI_API_KEY: "secret-key" },
    });

    const { initCodexProjectRunner } = await import("./codex/codex-project");
    initCodexProjectRunner();
    const spawner = getCodexProjectSpawner();

    await spawner!.spawnCodexAppServer!({
      projectId: "6bc2c387-4c80-4a79-aa68-65d8e68a6a52",
      accountId: "00000000-0000-4000-8000-000000000001",
      cwd: "/root",
    });

    expect(hubApi.projects.start).toHaveBeenCalledWith({
      project_id: "6bc2c387-4c80-4a79-aa68-65d8e68a6a52",
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("does not force ephemeral auth storage for shared-home auth", async () => {
    spawnMock.mockReturnValue(new FakeProc());
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      if (args[0] === "inspect" && args[1] === "-f") {
        cb(null, "true\n", "");
        return;
      }
      cb(null, "", "");
    });
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-project-test-"));
    const home = path.join(tmp, "home");
    const sharedHome = path.join(tmp, "shared-home");
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(sharedHome, { recursive: true });
    filesystem.localPath.mockResolvedValue({ home, scratch: undefined });
    auth.resolveCodexAuthRuntime.mockResolvedValue({
      source: "shared-home",
      contextId: "shared-home-1234",
      codexHome: sharedHome,
      env: {},
    });

    const { initCodexProjectRunner } = await import("./codex/codex-project");
    initCodexProjectRunner();
    const spawner = getCodexProjectSpawner();

    await spawner!.spawnCodexAppServer!({
      projectId: "6bc2c387-4c80-4a79-aa68-65d8e68a6a52",
      accountId: "00000000-0000-4000-8000-000000000001",
      cwd: "/root",
    });

    expect(spawnMock.mock.calls[0][1]).not.toContain(
      'cli_auth_credentials_store="ephemeral"',
    );
  });

  it("uses the dangerous runtime codex override when explicitly configured", async () => {
    spawnMock.mockReturnValue(new FakeProc());
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      if (args[0] === "inspect" && args[1] === "-f") {
        cb(null, "true\n", "");
        return;
      }
      cb(null, "", "");
    });
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-project-test-"));
    const home = path.join(tmp, "home");
    await fs.mkdir(home, { recursive: true });
    filesystem.localPath.mockResolvedValue({ home, scratch: undefined });
    auth.resolveCodexAuthRuntime.mockResolvedValue({
      source: "account-api-key",
      contextId: "acct-key-1234",
      env: { OPENAI_API_KEY: "secret-key" },
    });
    process.env.COCALC_DANGEROUS_PROJECT_RUNTIME_CODEX_PATH_OVERRIDE =
      "/tmp/debug-codex";

    const { initCodexProjectRunner } = await import("./codex/codex-project");
    initCodexProjectRunner();
    const spawner = getCodexProjectSpawner();

    await spawner!.spawnCodexAppServer!({
      projectId: "6bc2c387-4c80-4a79-aa68-65d8e68a6a52",
      accountId: "00000000-0000-4000-8000-000000000001",
      cwd: "/root",
    });

    expect(spawnMock.mock.calls[0][1]).toContain("/tmp/debug-codex");
  });
});

describe("getBuiltinLaunchpadSkillMounts", () => {
  const originalHome = process.env.HOME;
  const originalCodexHome = process.env.COCALC_CODEX_HOME;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalCodexHome === undefined) {
      delete process.env.COCALC_CODEX_HOME;
    } else {
      process.env.COCALC_CODEX_HOME = originalCodexHome;
    }
    jest.resetModules();
  });

  it("injects the built-in cocalc skill when the project does not already have it", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-skill-test-"));
    const hostHome = path.join(tmp, "host-home");
    const projectHome = path.join(tmp, "project-home");
    const hostSkill = path.join(hostHome, ".codex", "skills", "cocalc");
    await fs.mkdir(hostSkill, { recursive: true });
    await fs.mkdir(projectHome, { recursive: true });
    await fs.writeFile(path.join(hostSkill, "SKILL.md"), "# cocalc\n");
    process.env.HOME = hostHome;
    delete process.env.COCALC_CODEX_HOME;

    const { getBuiltinLaunchpadSkillMounts } =
      await import("./codex/codex-project");

    await expect(getBuiltinLaunchpadSkillMounts(projectHome)).resolves.toEqual([
      {
        source: hostSkill,
        target: "/home/user/.codex/skills/cocalc",
        readOnly: true,
      },
    ]);
  });

  it("does not override a project-local cocalc skill", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-skill-test-"));
    const hostHome = path.join(tmp, "host-home");
    const projectHome = path.join(tmp, "project-home");
    const hostSkill = path.join(hostHome, ".codex", "skills", "cocalc");
    const projectSkill = path.join(projectHome, ".codex", "skills", "cocalc");
    await fs.mkdir(hostSkill, { recursive: true });
    await fs.mkdir(projectSkill, { recursive: true });
    await fs.writeFile(path.join(hostSkill, "SKILL.md"), "# host cocalc\n");
    await fs.writeFile(
      path.join(projectSkill, "SKILL.md"),
      "# project cocalc\n",
    );
    process.env.HOME = hostHome;
    delete process.env.COCALC_CODEX_HOME;

    const { getBuiltinLaunchpadSkillMounts } =
      await import("./codex/codex-project");

    await expect(getBuiltinLaunchpadSkillMounts(projectHome)).resolves.toEqual(
      [],
    );
  });
});
