import { EventEmitter } from "node:events";
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
  networkArgument: jest.fn(() => "--network=slirp4netns"),
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

class FakeProc extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
}

describe("initCodexProjectRunner", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    execFileMock.mockReset();
    execMock.mockReset();
    podmanEnvMock.mockClear();
    setCodexProjectSpawner(null);
  });

  afterEach(() => {
    setCodexProjectSpawner(null);
  });

  it("uses podmanEnv for project-runtime app-server exec", async () => {
    spawnMock.mockReturnValue(new FakeProc());

    const { initCodexProjectRunner } = await import("./codex/codex-project");
    initCodexProjectRunner();
    const spawner = getCodexProjectSpawner();
    expect(spawner?.spawnCodexAppServer).toBeDefined();

    await spawner!.spawnCodexAppServer!({
      projectId: "6bc2c387-4c80-4a79-aa68-65d8e68a6a52",
      cwd: "/root",
      env: {
        FOO: "bar",
      },
    });

    expect(podmanEnvMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnMock.mock.calls[0];
    expect(command).toBe("podman");
    expect(args).toEqual([
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
      "app-server",
      "--listen",
      "stdio://",
    ]);
    expect(options).toMatchObject({
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        XDG_RUNTIME_DIR: "/tmp/cocalc-podman-runtime",
        CONTAINERS_CGROUP_MANAGER: "cgroupfs",
      },
    });
  });
});
