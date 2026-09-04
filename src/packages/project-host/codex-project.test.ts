import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { getCodexProjectSpawner, setCodexProjectSpawner } from "@cocalc/ai/acp";
import { DEFAULT_PROJECT_RUNTIME_UID } from "@cocalc/util/project-runtime";

const spawnMock = jest.fn();
const execFileMock = jest.fn();
const execMock = jest.fn();
const mockStartProjectWithAdmission = jest.fn();
const refreshSubscriptionAuthFromRegistryMock = jest.fn();
const restrictedEgressCloseMock = jest.fn();
const startRestrictedCodexEgressProxySessionMock = jest.fn(async () => ({
  proxyUrl:
    "http://cocalc-codex:restricted-token@host.containers.internal:43128",
  close: restrictedEgressCloseMock,
}));
const resolveHostContainersInternalAddressMock = jest.fn(
  async () => "10.206.0.1",
);
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
  podmanRuntimeArgs: jest.fn(async () => []),
  projectPoolPodmanLauncher: jest.fn(() => ({
    command: "podman",
    argsPrefix: [],
  })),
  resolveHostContainersInternalAddress: (...args: any[]) =>
    resolveHostContainersInternalAddressMock(...args),
  resolveSharedScratchMount: jest.fn(async () => undefined),
  verifyProjectContainerInPool: jest.fn(async () => undefined),
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
  refreshSubscriptionAuthFromRegistry: (...args: any[]) =>
    refreshSubscriptionAuthFromRegistryMock(...args),
  syncSubscriptionAuthToRegistryIfChanged: jest.fn(),
}));

jest.mock("./codex/restricted-egress-proxy", () => ({
  startRestrictedCodexEgressProxySession: () =>
    startRestrictedCodexEgressProxySessionMock(),
}));

jest.mock("./last-edited", () => ({
  touchProjectLastEdited: jest.fn(),
}));

jest.mock("./project-start-admission", () => ({
  startProjectWithAdmission: (...args: any[]) =>
    mockStartProjectWithAdmission(...args),
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

const tempDirs: string[] = [];

async function mkTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      fs.rm(dir, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

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
      run_quota: { network: true },
    });
    hubApi.projects.start.mockReset();
    hubApi.projects.start.mockResolvedValue({});
    mockStartProjectWithAdmission.mockReset();
    mockStartProjectWithAdmission.mockResolvedValue({});
    refreshSubscriptionAuthFromRegistryMock.mockReset();
    refreshSubscriptionAuthFromRegistryMock.mockResolvedValue({
      refreshed: true,
    });
    restrictedEgressCloseMock.mockReset();
    startRestrictedCodexEgressProxySessionMock.mockClear();
    resolveHostContainersInternalAddressMock.mockClear();
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
    const tmp = await mkTempDir("codex-project-test-");
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
      cwd: "/home/user",
      env: {
        FOO: "bar",
        COCALC_API_URL: "http://localhost:7103",
        COCALC_PROFILE: "prod",
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
        `${DEFAULT_PROJECT_RUNTIME_UID}:${DEFAULT_PROJECT_RUNTIME_UID}`,
        "--workdir",
        "/home/user",
        "-e",
        "HOME=/home/user",
        "-e",
        "USER=user",
        "-e",
        "LOGNAME=user",
        "-e",
        expect.stringMatching(
          /^COCALC_BEARER_TOKEN_FILE=\/home\/user\/\.local\/share\/cocalc\/runtime\/\.cocalc-agent-[^/]+\/token$/,
        ),
        "-e",
        expect.stringMatching(
          /^COCALC_AGENT_TOKEN_FILE=\/home\/user\/\.local\/share\/cocalc\/runtime\/\.cocalc-agent-[^/]+\/token$/,
        ),
        "-e",
        "COCALC_PROFILE=_env",
        "-e",
        "FOO=bar",
        "-e",
        "COCALC_API_URL=http://host.containers.internal:7103",
        "project-6bc2c387-4c80-4a79-aa68-65d8e68a6a52",
        "/opt/cocalc/bin2/codex",
        "--config",
        'cli_auth_credentials_store="ephemeral"',
        "image_generation",
        "background_paginated_rollout_migration",
        "local_thread_store_compression",
        "app-server",
        "--listen",
        "stdio://",
      ]),
    );
    expect(args).not.toContain("OPENAI_API_KEY=secret-key");
    expect(args).not.toContain(
      'model_providers.cocalc-openai-api-key={name="OpenAI",base_url="https://api.openai.com/v1",env_key="OPENAI_API_KEY",wire_api="responses",requires_openai_auth=false,supports_websockets=true,stream_idle_timeout_ms=1800000,websocket_connect_timeout_ms=60000}',
    );
    expect(args).not.toContain('model_provider="cocalc-openai-api-key"');
    expect(options).toMatchObject({
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        XDG_RUNTIME_DIR: "/tmp/cocalc-podman-runtime",
        CONTAINERS_CGROUP_MANAGER: "cgroupfs",
      },
    });
    expect(spawned.authSource).toBe("account-api-key");
    expect(spawned.logArgs).toContain("COCALC_BEARER_TOKEN_FILE=***");
    expect(spawned.logArgs).not.toContain("issued-project-host-token");
    expect(spawned.runtimeEnv).toMatchObject({
      COCALC_API_URL: "http://host.containers.internal:7103",
      COCALC_BEARER_TOKEN_FILE: expect.stringMatching(
        /^\/home\/user\/\.local\/share\/cocalc\/runtime\/\.cocalc-agent-[^/]+\/token$/,
      ),
      COCALC_AGENT_TOKEN_FILE: expect.stringMatching(
        /^\/home\/user\/\.local\/share\/cocalc\/runtime\/\.cocalc-agent-[^/]+\/token$/,
      ),
      COCALC_ACCOUNT_ID: "00000000-0000-4000-8000-000000000001",
      COCALC_PROFILE: "_env",
    });
    expect(spawned.runtimeEnv?.COCALC_BEARER_TOKEN).toBeUndefined();
    expect(spawned.runtimeEnv?.COCALC_AGENT_TOKEN).toBeUndefined();
    const runtimeTokenPath = spawned.runtimeEnv?.COCALC_BEARER_TOKEN_FILE;
    expect(runtimeTokenPath).toBeTruthy();
    expect(
      await fs.readFile(runtimeTokenPath!.replace("/home/user", home), "utf8"),
    ).toBe("issued-project-host-token\n");
    expect(spawned.appServerLogin).toEqual({
      type: "apiKey",
      apiKey: "secret-key",
    });
    expect(hubApi.hosts.issueProjectHostAgentAuthToken).toHaveBeenCalledWith({
      account_id: "00000000-0000-4000-8000-000000000001",
      project_id: "6bc2c387-4c80-4a79-aa68-65d8e68a6a52",
      session_id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    });
    expect(spawned.containerPathMap).toEqual({
      rootHostPath: home,
      scratchHostPath: undefined,
    });
  });

  it("uses and removes an isolated Codex home for account status probes", async () => {
    const proc = new FakeProc();
    spawnMock.mockReturnValue(proc);
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      if (args[0] === "inspect" && args[1] === "-f") {
        cb(null, "true\n", "");
        return;
      }
      cb(null, "", "");
    });
    const tmp = await mkTempDir("codex-project-status-test-");
    const home = path.join(tmp, "home");
    const scratch = path.join(tmp, "scratch");
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(scratch, { recursive: true });
    filesystem.localPath.mockResolvedValue({ home, scratch });
    auth.resolveCodexAuthRuntime.mockResolvedValue({
      source: "subscription",
      contextId: "subscription-account-1",
      codexHome: path.join(tmp, "subscription-home"),
      env: {},
    });

    const { initCodexProjectRunner } = await import("./codex/codex-project");
    initCodexProjectRunner();
    await getCodexProjectSpawner()!.spawnCodexAppServer!({
      projectId: "6bc2c387-4c80-4a79-aa68-65d8e68a6a52",
      accountId: "00000000-0000-4000-8000-000000000001",
      isolatedCodexHome: true,
    });

    const args = spawnMock.mock.calls[0][1] as string[];
    const codexHomeEnv = args.find((arg) =>
      arg.startsWith("CODEX_HOME=/tmp/.cocalc/codex-account-status/"),
    );
    expect(codexHomeEnv).toBeDefined();
    const containerPath = codexHomeEnv!.slice("CODEX_HOME=".length);
    const hostPath = path.join(scratch, containerPath.slice("/tmp/".length));
    await expect(fs.stat(hostPath)).resolves.toMatchObject({});

    proc.emit("close", 0, null);
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await fs.stat(hostPath);
      } catch (err) {
        expect(err).toMatchObject({ code: "ENOENT" });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("isolated Codex home was not removed");
  });

  it("routes Codex through restricted OpenAI egress when project network is disabled", async () => {
    const proc = new FakeProc();
    spawnMock.mockReturnValue(proc);
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      if (args[0] === "inspect" && args[1] === "-f") {
        cb(null, "true\n", "");
        return;
      }
      cb(null, "", "");
    });
    const tmp = await mkTempDir("codex-project-test-");
    const home = path.join(tmp, "home");
    await fs.mkdir(home, { recursive: true });
    filesystem.localPath.mockResolvedValue({ home, scratch: undefined });
    projects.getProject.mockReturnValue({
      state: "running",
      run_quota: {},
    });
    auth.resolveCodexAuthRuntime.mockResolvedValue({
      source: "account-api-key",
      contextId: "acct-key-1234",
      env: { OPENAI_API_KEY: "secret-key" },
    });

    const { initCodexProjectRunner } = await import("./codex/codex-project");
    initCodexProjectRunner();
    const spawned = await getCodexProjectSpawner()!.spawnCodexAppServer!({
      projectId: "6bc2c387-4c80-4a79-aa68-65d8e68a6a52",
      accountId: "00000000-0000-4000-8000-000000000001",
      cwd: "/home/user",
    });

    const args = spawnMock.mock.calls[0][1];
    expect(args).toEqual(
      expect.arrayContaining([
        "-e",
        "HTTPS_PROXY=http://cocalc-codex:restricted-token@host.containers.internal:43128",
        "-e",
        "https_proxy=http://cocalc-codex:restricted-token@host.containers.internal:43128",
        "--config",
        "features.respect_system_proxy=true",
      ]),
    );
    expect(spawned.logArgs).toContain("HTTPS_PROXY=***");
    expect(spawned.logArgs).not.toContain("restricted-token");
    expect(spawned.runtimeEnv?.HTTPS_PROXY).toBeUndefined();
    expect(startRestrictedCodexEgressProxySessionMock).toHaveBeenCalledTimes(1);

    proc.emit("close", 0, null);
    expect(restrictedEgressCloseMock).toHaveBeenCalledTimes(1);
  });

  it("adds the host alias and protected auth mount to a Codex container", async () => {
    const proc = new FakeProc();
    spawnMock.mockReturnValue(proc);
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      const name = `${args.at(-1) ?? ""}`;
      if (args[0] === "inspect" && name.startsWith("project-")) {
        cb(null, "true\n", "");
        return;
      }
      if (args[0] === "container" && args[1] === "exists") {
        cb(Object.assign(new Error("no such container"), { code: 1 }), "", "");
        return;
      }
      cb(null, "", "");
    });
    const tmp = await mkTempDir("codex-project-host-alias-test-");
    const bin = path.join(tmp, "bin");
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, "codex"), "");
    const home = path.join(tmp, "home");
    await fs.mkdir(home, { recursive: true });
    const codexHome = path.join(tmp, "subscription-home");
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(path.join(codexHome, "auth.json"), "{}\n");
    await fs.writeFile(path.join(codexHome, "config.toml"), "");
    const imageFile = path.join(tmp, "image-name.txt");
    await fs.writeFile(imageFile, "buildpack-deps:noble-scm\n");
    filesystem.localPath.mockResolvedValue({ home, scratch: undefined });
    jest
      .requireMock("@cocalc/project-runner/run/rootfs")
      .getImageNamePath.mockReturnValue(imageFile);
    jest
      .requireMock("@cocalc/project-runner/run/rootfs")
      .mount.mockResolvedValue(path.join(tmp, "rootfs"));
    jest
      .requireMock("@cocalc/project-runner/run/env")
      .getEnvironment.mockResolvedValue({});
    jest
      .requireMock("@cocalc/backend/podman")
      .mountArg.mockImplementation(
        ({ source, target }) => `--volume=${source}:${target}`,
      );
    auth.resolveCodexAuthRuntime.mockResolvedValue({
      source: "subscription",
      contextId: "host-alias-test",
      codexHome,
      env: {},
    });
    process.env.COCALC_BIN_PATH = bin;

    const { initCodexProjectRunner } = await import("./codex/codex-project");
    initCodexProjectRunner();
    await getCodexProjectSpawner()!.spawnCodexExec!({
      projectId: "77777777-7777-4777-8777-777777777777",
      accountId: "00000000-0000-4000-8000-000000000001",
      cwd: "/home/user",
      args: ["login", "--device-auth"],
    });

    expect(resolveHostContainersInternalAddressMock).toHaveBeenCalledWith(
      "--network=pasta:--map-gw",
    );
    const runCall = execFileMock.mock.calls.find(
      ([, args]) => args[0] === "run",
    );
    expect(runCall).toBeDefined();
    expect(runCall![1]).toEqual(
      expect.arrayContaining([
        "--network=pasta:--map-gw",
        "--add-host",
        "host.containers.internal:10.206.0.1",
        `--volume=${codexHome}:/run/cocalc/codex-subscription`,
      ]),
    );

    proc.emit("close", 0, null);
  });

  it("uses runtime account id to issue the CLI agent bearer", async () => {
    spawnMock.mockReturnValue(new FakeProc());
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      if (args[0] === "inspect" && args[1] === "-f") {
        cb(null, "true\n", "");
        return;
      }
      cb(null, "", "");
    });
    const tmp = await mkTempDir("codex-project-test-");
    const bin = path.join(tmp, "bin");
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, "codex"), "");
    const home = path.join(tmp, "home");
    await fs.mkdir(home, { recursive: true });
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

    const spawned = await spawner!.spawnCodexAppServer!({
      projectId: "6bc2c387-4c80-4a79-aa68-65d8e68a6a52",
      cwd: "/home/user",
      env: {
        COCALC_ACCOUNT_ID: "00000000-0000-4000-8000-000000000001",
      },
    });

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toEqual(
      expect.arrayContaining([
        "-e",
        expect.stringMatching(/^COCALC_BEARER_TOKEN_FILE=\/home\/user\//),
        "-e",
        expect.stringMatching(/^COCALC_AGENT_TOKEN_FILE=\/home\/user\//),
        "-e",
        "COCALC_ACCOUNT_ID=00000000-0000-4000-8000-000000000001",
      ]),
    );
    expect(spawned.runtimeEnv).toMatchObject({
      COCALC_BEARER_TOKEN_FILE: expect.stringMatching(
        /^\/home\/user\/\.local\/share\/cocalc\/runtime\//,
      ),
      COCALC_AGENT_TOKEN_FILE: expect.stringMatching(
        /^\/home\/user\/\.local\/share\/cocalc\/runtime\//,
      ),
      COCALC_ACCOUNT_ID: "00000000-0000-4000-8000-000000000001",
    });
    expect(hubApi.hosts.issueProjectHostAgentAuthToken).toHaveBeenCalledWith({
      account_id: "00000000-0000-4000-8000-000000000001",
      project_id: "6bc2c387-4c80-4a79-aa68-65d8e68a6a52",
      session_id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    });
  });

  it("rotates and removes the project-scoped CLI token lease", async () => {
    const scratch = await mkTempDir("codex-project-scratch-");
    hubApi.hosts.issueProjectHostAgentAuthToken
      .mockResolvedValueOnce({
        token: "first-project-token",
        expires_at: Date.now() + 60_000,
      })
      .mockResolvedValueOnce({
        token: "second-project-token",
        expires_at: Date.now() + 60_000,
      });
    const { createProjectCliTokenLease } =
      await import("./codex/codex-project");
    const lease = await createProjectCliTokenLease({
      projectId: "6bc2c387-4c80-4a79-aa68-65d8e68a6a52",
      accountId: "00000000-0000-4000-8000-000000000001",
      currentEnv: {},
      home: scratch,
      scratch,
      refreshMs: 10,
    });
    expect(lease).toBeDefined();
    expect(lease!.containerPath).toMatch(/^\/tmp\/\.cocalc-agent-/);
    expect(await fs.readFile(lease!.hostPath, "utf8")).toBe(
      "first-project-token\n",
    );

    for (let i = 0; i < 20; i++) {
      if (
        (await fs.readFile(lease!.hostPath, "utf8")) ===
        "second-project-token\n"
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await fs.readFile(lease!.hostPath, "utf8")).toBe(
      "second-project-token\n",
    );
    const sessionIds =
      hubApi.hosts.issueProjectHostAgentAuthToken.mock.calls.map(
        ([opts]) => opts.session_id,
      );
    expect(new Set(sessionIds).size).toBe(1);
    expect(sessionIds[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    await lease!.close();
    await expect(fs.stat(lease!.hostPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps token lease ownership with the rootless Podman host user", async () => {
    const scratch = await mkTempDir("codex-project-scratch-ownership-");
    const chown = jest
      .spyOn(fs, "chown")
      .mockRejectedValue(
        Object.assign(new Error("chown denied"), { code: "EPERM" }),
      );
    try {
      const { createProjectCliTokenLease } =
        await import("./codex/codex-project");
      const lease = await createProjectCliTokenLease({
        projectId: "6bc2c387-4c80-4a79-aa68-65d8e68a6a52",
        accountId: "00000000-0000-4000-8000-000000000001",
        currentEnv: {},
        home: scratch,
        scratch,
        refreshMs: 60_000,
      });

      expect(lease).toBeDefined();
      expect(chown).not.toHaveBeenCalled();
      const directory = await fs.stat(path.dirname(lease!.hostPath));
      const token = await fs.stat(lease!.hostPath);
      expect(directory.mode & 0o777).toBe(0o700);
      expect(token.mode & 0o777).toBe(0o600);
      await lease!.close();
    } finally {
      chown.mockRestore();
    }
  });

  it("keeps a turn identity across restarts and rotates it for a new turn", async () => {
    const scratch = await mkTempDir("codex-project-turn-token-");
    hubApi.hosts.issueProjectHostAgentAuthToken
      .mockResolvedValueOnce({
        token: "turn-one-token",
        expires_at: Date.now() + 60_000,
      })
      .mockResolvedValueOnce({
        token: "turn-two-token",
        expires_at: Date.now() + 60_000,
      })
      .mockResolvedValueOnce({
        token: "turn-two-restart-token",
        expires_at: Date.now() + 60_000,
      });
    const { createProjectCliTokenLease } =
      await import("./codex/codex-project");
    const common = {
      projectId: "6bc2c387-4c80-4a79-aa68-65d8e68a6a52",
      accountId: "00000000-0000-4000-8000-000000000001",
      currentEnv: {},
      home: scratch,
      scratch,
      refreshMs: 60_000,
    };
    const first = await createProjectCliTokenLease({
      ...common,
      agentSessionKey: "thread-1\0turn-1",
    });
    const firstSessionId =
      hubApi.hosts.issueProjectHostAgentAuthToken.mock.calls[0][0].session_id;

    await first!.setAgentSessionKey("thread-1\0turn-2");
    const secondSessionId =
      hubApi.hosts.issueProjectHostAgentAuthToken.mock.calls[1][0].session_id;
    expect(secondSessionId).not.toBe(firstSessionId);
    expect(await fs.readFile(first!.hostPath, "utf8")).toBe("turn-two-token\n");
    await first!.close();

    const restarted = await createProjectCliTokenLease({
      ...common,
      agentSessionKey: "thread-1\0turn-2",
    });
    const restartedSessionId =
      hubApi.hosts.issueProjectHostAgentAuthToken.mock.calls[2][0].session_id;
    expect(restartedSessionId).toBe(secondSessionId);
    await restarted!.close();
  });

  it("retries transient failures while rotating a turn token", async () => {
    const scratch = await mkTempDir("codex-project-turn-token-retry-");
    hubApi.hosts.issueProjectHostAgentAuthToken
      .mockResolvedValueOnce({
        token: "turn-one-token",
        expires_at: Date.now() + 60_000,
      })
      .mockRejectedValueOnce(Object.assign(new Error("timeout"), { code: 408 }))
      .mockResolvedValueOnce({
        token: "turn-two-token",
        expires_at: Date.now() + 60_000,
      });
    const { createProjectCliTokenLease } =
      await import("./codex/codex-project");
    const lease = await createProjectCliTokenLease({
      projectId: "6bc2c387-4c80-4a79-aa68-65d8e68a6a52",
      accountId: "00000000-0000-4000-8000-000000000001",
      agentSessionKey: "thread-1\0turn-1",
      currentEnv: {},
      home: scratch,
      scratch,
      refreshMs: 60_000,
    });

    try {
      await lease!.setAgentSessionKey("thread-1\0turn-2");
      expect(await fs.readFile(lease!.hostPath, "utf8")).toBe(
        "turn-two-token\n",
      );
      expect(hubApi.hosts.issueProjectHostAgentAuthToken).toHaveBeenCalledTimes(
        3,
      );
      const calls = hubApi.hosts.issueProjectHostAgentAuthToken.mock.calls;
      expect(calls[1][0].session_id).toBe(calls[2][0].session_id);
      expect(calls[1][0].session_id).not.toBe(calls[0][0].session_id);
    } finally {
      await lease!.close();
    }
  });

  it("does not retry authorization failures while rotating a turn token", async () => {
    const scratch = await mkTempDir("codex-project-turn-token-denied-");
    hubApi.hosts.issueProjectHostAgentAuthToken
      .mockResolvedValueOnce({
        token: "turn-one-token",
        expires_at: Date.now() + 60_000,
      })
      .mockRejectedValueOnce(new Error("not authorized"));
    const { createProjectCliTokenLease } =
      await import("./codex/codex-project");
    const lease = await createProjectCliTokenLease({
      projectId: "6bc2c387-4c80-4a79-aa68-65d8e68a6a52",
      accountId: "00000000-0000-4000-8000-000000000001",
      agentSessionKey: "thread-1\0turn-1",
      currentEnv: {},
      home: scratch,
      scratch,
      refreshMs: 60_000,
    });

    try {
      await expect(
        lease!.setAgentSessionKey("thread-1\0turn-2"),
      ).rejects.toThrow("unable to rotate the project-scoped agent token");
      expect(hubApi.hosts.issueProjectHostAgentAuthToken).toHaveBeenCalledTimes(
        2,
      );
      expect(await fs.readFile(lease!.hostPath, "utf8")).toBe(
        "turn-one-token\n",
      );
    } finally {
      await lease!.close();
    }
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
    const tmp = await mkTempDir("codex-project-test-");
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
        cwd: "/home/user",
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
    const tmp = await mkTempDir("codex-project-test-");
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
      cwd: "/home/user",
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
    const tmp = await mkTempDir("codex-project-test-");
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
      cwd: "/home/user",
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

  it("accepts only a newer app-server ChatGPT token refresh", async () => {
    spawnMock.mockReturnValue(new FakeProc());
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      if (args[0] === "inspect" && args[1] === "-f") {
        cb(null, "true\n", "");
        return;
      }
      cb(null, "", "");
    });
    const tmp = await mkTempDir("codex-project-test-");
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
    const refreshedAccessToken = jwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "workspace-123",
        chatgpt_plan_type: "pro",
      },
      token_version: "refreshed",
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
    refreshSubscriptionAuthFromRegistryMock.mockImplementation(async () => {
      await fs.writeFile(
        path.join(codexHome, "auth.json"),
        JSON.stringify({
          tokens: {
            access_token: refreshedAccessToken,
            account_id: "workspace-123",
          },
        }),
      );
      return { refreshed: true };
    });

    const { initCodexProjectRunner } = await import("./codex/codex-project");
    initCodexProjectRunner();
    const spawner = getCodexProjectSpawner();
    const spawned = await spawner!.spawnCodexAppServer!({
      projectId: "6bc2c387-4c80-4a79-aa68-65d8e68a6a52",
      accountId: "00000000-0000-4000-8000-000000000001",
      cwd: "/home/user",
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
      accessToken: refreshedAccessToken,
      chatgptAccountId: "workspace-123",
      chatgptPlanType: "pro",
    });
    expect(refreshSubscriptionAuthFromRegistryMock).toHaveBeenCalledWith({
      projectId: "6bc2c387-4c80-4a79-aa68-65d8e68a6a52",
      accountId: "00000000-0000-4000-8000-000000000001",
      codexHome,
      previousAccessTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    refreshSubscriptionAuthFromRegistryMock.mockResolvedValue({
      refreshed: false,
    });
    await expect(
      spawned.handleAppServerRequest?.({
        id: 18,
        method: "account/chatgptAuthTokens/refresh",
        params: {
          reason: "unauthorized",
          previousAccountId: "workspace-123",
        },
      }),
    ).rejects.toThrow("unchanged access token");
    expect(spawnMock.mock.calls[0][1]).not.toContain(
      "OPENAI_API_KEY=secret-key",
    );
  });

  it("removes broken local codex auth artifacts before app-server startup", async () => {
    spawnMock.mockReturnValue(new FakeProc());
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      if (args[0] === "inspect" && args[1] === "-f") {
        cb(null, "true\n", "");
        return;
      }
      cb(null, "", "");
    });
    const tmp = await mkTempDir("codex-project-test-");
    const bin = path.join(tmp, "bin");
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, "codex"), "");
    const home = path.join(tmp, "home");
    const codexHome = path.join(home, ".codex");
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(path.join(codexHome, "config.toml"), "");
    await fs.writeFile(path.join(codexHome, "auth.json"), "");
    const imageFile = path.join(tmp, "image-name.txt");
    await fs.writeFile(imageFile, "buildpack-deps:noble-scm\n");
    filesystem.localPath.mockResolvedValue({ home, scratch: undefined });
    auth.resolveCodexAuthRuntime.mockResolvedValue({
      source: "subscription",
      contextId: "subscription-1234",
      codexHome: path.join(tmp, "subscription-home"),
      env: {},
    });
    process.env.COCALC_BIN_PATH = bin;

    const { initCodexProjectRunner } = await import("./codex/codex-project");
    initCodexProjectRunner();
    const spawner = getCodexProjectSpawner();
    await spawner!.spawnCodexAppServer!({
      projectId: "6bc2c387-4c80-4a79-aa68-65d8e68a6a52",
      accountId: "00000000-0000-4000-8000-000000000001",
      cwd: "/home/user",
    });

    await expect(
      fs.stat(path.join(codexHome, "config.toml")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.stat(path.join(codexHome, "auth.json")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps non-empty local codex config before app-server startup", async () => {
    spawnMock.mockReturnValue(new FakeProc());
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      if (args[0] === "inspect" && args[1] === "-f") {
        cb(null, "true\n", "");
        return;
      }
      cb(null, "", "");
    });
    const tmp = await mkTempDir("codex-project-test-");
    const bin = path.join(tmp, "bin");
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, "codex"), "");
    const home = path.join(tmp, "home");
    const codexHome = path.join(home, ".codex");
    await fs.mkdir(codexHome, { recursive: true });
    const configPath = path.join(codexHome, "config.toml");
    await fs.writeFile(configPath, 'model = "gpt-5"\n');
    const imageFile = path.join(tmp, "image-name.txt");
    await fs.writeFile(imageFile, "buildpack-deps:noble-scm\n");
    filesystem.localPath.mockResolvedValue({ home, scratch: undefined });
    auth.resolveCodexAuthRuntime.mockResolvedValue({
      source: "account-api-key",
      contextId: "account-key-1234",
      env: { OPENAI_API_KEY: "secret-key" },
    });
    process.env.COCALC_BIN_PATH = bin;

    const { initCodexProjectRunner } = await import("./codex/codex-project");
    initCodexProjectRunner();
    const spawner = getCodexProjectSpawner();
    await spawner!.spawnCodexAppServer!({
      projectId: "6bc2c387-4c80-4a79-aa68-65d8e68a6a52",
      accountId: "00000000-0000-4000-8000-000000000001",
      cwd: "/home/user",
    });

    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(
      'model = "gpt-5"\n',
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
    const tmp = await mkTempDir("codex-project-test-");
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
      cwd: "/home/user",
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
    expect(refreshSubscriptionAuthFromRegistryMock).not.toHaveBeenCalled();
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
    const tmp = await mkTempDir("codex-project-test-");
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
      cwd: "/home/user",
    });

    expect(mockStartProjectWithAdmission).toHaveBeenCalledWith({
      account_id: "00000000-0000-4000-8000-000000000001",
      project_id: "6bc2c387-4c80-4a79-aa68-65d8e68a6a52",
      autostart: true,
      timeout: 180000,
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("forces a start when the cached project row says running but the container is missing", async () => {
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
      state: "running",
      run_quota: { network: true },
    });
    const tmp = await mkTempDir("codex-project-test-");
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
      cwd: "/home/user",
    });

    expect(mockStartProjectWithAdmission).toHaveBeenCalledWith({
      account_id: "00000000-0000-4000-8000-000000000001",
      project_id: "6bc2c387-4c80-4a79-aa68-65d8e68a6a52",
      autostart: true,
      timeout: 180000,
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("accepts a running container when inspect fails but podman ps still shows it", async () => {
    spawnMock.mockReturnValue(new FakeProc());
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      if (args[0] === "inspect" && args[1] === "-f") {
        cb(
          new Error("inspect transient failure"),
          "",
          "inspect transient failure",
        );
        return;
      }
      if (args[0] === "ps") {
        cb(null, "project-6bc2c387-4c80-4a79-aa68-65d8e68a6a52\n", "");
        return;
      }
      cb(null, "", "");
    });
    const tmp = await mkTempDir("codex-project-test-");
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
      cwd: "/home/user",
    });

    expect(mockStartProjectWithAdmission).not.toHaveBeenCalled();
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
    const tmp = await mkTempDir("codex-project-test-");
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
      cwd: "/home/user",
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
    const tmp = await mkTempDir("codex-project-test-");
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
      cwd: "/home/user",
    });

    expect(spawnMock.mock.calls[0][1]).toContain("/tmp/debug-codex");
  });
});

describe("getBuiltinLaunchpadSkillMounts", () => {
  afterEach(() => {
    jest.resetModules();
  });

  it("mounts the canonical cocalc skill when the project does not override it", async () => {
    const tmp = await mkTempDir("codex-skill-test-");
    const projectHome = path.join(tmp, "project-home");
    const packagedSkills = path.join(tmp, "packaged-skills");
    const packagedSkill = path.join(packagedSkills, "cocalc");
    await fs.mkdir(packagedSkill, { recursive: true });
    await fs.mkdir(projectHome, { recursive: true });
    await fs.writeFile(path.join(packagedSkill, "SKILL.md"), "# cocalc\n");

    const { getBuiltinLaunchpadSkillMounts } =
      await import("./codex/codex-project");

    await expect(
      getBuiltinLaunchpadSkillMounts(projectHome, packagedSkills),
    ).resolves.toEqual([
      {
        source: packagedSkill,
        target: "/home/user/.codex/skills/cocalc",
        readOnly: true,
      },
    ]);
  });

  it("does not override a project-local cocalc skill", async () => {
    const tmp = await mkTempDir("codex-skill-test-");
    const projectHome = path.join(tmp, "project-home");
    const packagedSkills = path.join(tmp, "packaged-skills");
    const packagedSkill = path.join(packagedSkills, "cocalc");
    const projectSkill = path.join(projectHome, ".codex", "skills", "cocalc");
    await fs.mkdir(packagedSkill, { recursive: true });
    await fs.mkdir(projectSkill, { recursive: true });
    await fs.writeFile(
      path.join(packagedSkill, "SKILL.md"),
      "# canonical cocalc\n",
    );
    await fs.writeFile(
      path.join(projectSkill, "SKILL.md"),
      "# project cocalc\n",
    );

    const { getBuiltinLaunchpadSkillMounts } =
      await import("./codex/codex-project");

    await expect(
      getBuiltinLaunchpadSkillMounts(projectHome, packagedSkills),
    ).resolves.toEqual([]);
  });

  it("fails clearly when the project-host artifact omits the canonical skill", async () => {
    const tmp = await mkTempDir("codex-skill-test-");
    const projectHome = path.join(tmp, "project-home");
    const packagedSkills = path.join(tmp, "missing-packaged-skills");
    await fs.mkdir(projectHome, { recursive: true });

    const { getBuiltinLaunchpadSkillMounts } =
      await import("./codex/codex-project");

    await expect(
      getBuiltinLaunchpadSkillMounts(projectHome, packagedSkills),
    ).rejects.toThrow("project-host artifact is missing canonical skills");
  });

  it("resolves a byte-identical canonical skill without using host home", async () => {
    const tmp = await mkTempDir("codex-skill-test-");
    const projectHome = path.join(tmp, "project-home");
    await fs.mkdir(projectHome, { recursive: true });

    const { getBuiltinLaunchpadSkillMounts } =
      await import("./codex/codex-project");
    const mounts = await getBuiltinLaunchpadSkillMounts(projectHome);
    const canonicalSkill = path.join(
      __dirname,
      "..",
      "cli",
      "skills",
      "cocalc",
      "SKILL.md",
    );

    expect(mounts).toHaveLength(1);
    expect(mounts[0].source).not.toContain(".codex/skills");
    await expect(
      fs.readFile(path.join(mounts[0].source, "SKILL.md"), "utf8"),
    ).resolves.toBe(await fs.readFile(canonicalSkill, "utf8"));
  });
});
