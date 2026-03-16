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
    delete process.env.COCALC_DANGEROUS_PROJECT_RUNTIME_CODEX_PATH_OVERRIDE;
    setCodexProjectSpawner(null);
    projects.getProject.mockReturnValue({
      state: "running",
      run_quota: {},
    });
    hubApi.projects.start.mockReset();
    hubApi.projects.start.mockResolvedValue({});
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
        "--workdir",
        "/root",
        "-e",
        "HOME=/root",
        "-e",
        "FOO=bar",
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
    expect(spawned.appServerLogin).toEqual({
      type: "apiKey",
      apiKey: "secret-key",
    });
    expect(spawned.containerPathMap).toEqual({
      rootHostPath: home,
      scratchHostPath: undefined,
    });
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
