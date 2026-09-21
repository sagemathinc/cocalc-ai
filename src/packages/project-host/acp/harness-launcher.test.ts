import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { launchHarnessInProject as launch } from "./harness-launcher";

const conversation = { path: "a.chat", threadId: "thread-a" };
const launchHarnessInProject = (input: typeof binding) =>
  launch(input, conversation);

const mockExec = jest.fn();
const mockSpawn = jest.fn();
const mockUnmount = jest.fn();
const mockStart = jest.fn();
const mockLease = jest.fn();
const mockCloseLease = jest.fn();
const mockForceKill = jest.fn();
jest.mock("node:child_process", () => ({
  execFile: (...args) => mockExec(...args),
  spawn: (...args) => mockSpawn(...args),
}));
jest.mock("node:fs/promises", () => ({ readFile: async () => "image" }));
jest.mock("./harness-reaper", () => ({
  harnessOwner: async () => "123:00000000-0000-0000-0000-000000000000:100",
  HARNESS_OWNER_LABEL: "cocalc.acp.owner",
}));
jest.mock("@cocalc/backend/logger", () => () => ({ warn: jest.fn() }));
jest.mock("@cocalc/backend/podman/env", () => ({
  podmanEnv: () => ({ ONLY_PODMAN: "yes" }),
}));
jest.mock("@cocalc/backend/podman", () => ({
  mountArg: ({ source, target, readOnly }) =>
    `mount:${source}:${target}:${readOnly}`,
}));
jest.mock("@cocalc/project-runner/run/filesystem", () => ({
  localPath: async () => ({ home: "/project-home", scratch: "/scratch" }),
}));
jest.mock("@cocalc/project-runner/run/rootfs", () => ({
  getImageNamePath: () => "image",
  mount: async () => "/rootfs",
  unmount: (...args) => mockUnmount(...args),
}));
jest.mock("@cocalc/project-runner/run/env", () => ({
  getEnvironment: async () => ({
    HOME: "/home/user",
    PROVIDER_KEY: "project-only",
    COCALC_BEARER_TOKEN: "stale-image-token",
    COCALC_AGENT_IDENTITY_FILE: "/stale/identity",
  }),
}));
jest.mock("@cocalc/project-runner/run/mounts", () => ({
  getCoCalcMounts: () => ({ "/cocalc": "/opt/cocalc" }),
}));
jest.mock("@cocalc/project-runner/run/podman", () => ({
  podmanRuntimeArgs: async () => [],
  projectSecretsHostPath: () => "/project-secrets",
  forceKillContainerProcesses: (...args) => mockForceKill(...args),
  projectPoolPodmanLauncher: () => ({
    command: "pool-launcher",
    argsPrefix: ["project-pool", "podman"],
  }),
}));
jest.mock("../codex/codex-project", () => ({
  ensureProjectContainerRunning: (...args) => mockStart(...args),
  createProjectCliTokenLease: (...args) => mockLease(...args),
  applyProjectRuntimeCliEnv: jest.fn(),
  resolveProjectRuntimeApiUrl: () => "http://project-hub",
}));
jest.mock("../sqlite/projects", () => ({
  getProject: () => ({ state: "running" }),
}));

const binding = {
  projectId: "1892b11a-6c63-4a92-988d-01dcddc0bc79",
  accountId: "8a52c640-079f-496d-85cb-0147bdf9fd6d",
  profile: {
    version: 1 as const,
    kind: "acp" as const,
    id: "test",
    revision: "1",
    executable: "/home/user/bin/harness",
    args: ["literal;not-a-shell"],
    cwd: "/home/user",
    credentialMode: "project-managed" as const,
    executionPolicy: "full-access" as const,
  },
};
let proc: any;
beforeEach(() => {
  jest.clearAllMocks();
  proc = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: jest.fn(() => {
      proc.emit("close");
    }),
  });
  mockSpawn.mockReturnValue(proc);
  mockExec.mockImplementation((_cmd, _args, _opts, cb) => cb(null));
  mockUnmount.mockResolvedValue(undefined);
  mockStart.mockResolvedValue(undefined);
  mockCloseLease.mockResolvedValue(undefined);
  mockLease.mockResolvedValue({
    containerPath: "/tmp/scoped/token",
    identityContainerPath: "/tmp/scoped/identity",
    close: mockCloseLease,
  });
});

test("sidecar preserves structured argv, project networking and pool containment", async () => {
  const handle = await launchHarnessInProject(binding);
  const [command, args, opts] = mockExec.mock.calls[0];
  expect(command).toBe("pool-launcher");
  expect(args.slice(0, 3)).toEqual(["project-pool", "podman", "create"]);
  expect(args).toContain(`--network=container:project-${binding.projectId}`);
  expect(args.slice(-4)).toEqual([
    "--rootfs",
    "/rootfs",
    binding.profile.executable,
    "literal;not-a-shell",
  ]);
  expect(opts.env).toEqual({ ONLY_PODMAN: "yes" });
  expect(args.join(" ")).not.toContain("stale-image-token");
  expect(args.join(" ")).not.toContain("/stale/identity");
  expect(args).toContain("COCALC_AGENT_IDENTITY_FILE=/tmp/scoped/identity");
  expect(args).toContain("COCALC_BEARER_TOKEN_FILE=/tmp/scoped/token");
  expect(args).toContainEqual(
    expect.stringMatching(/^mount:\/project-secrets:.*:true$/),
  );
  expect(mockLease.mock.calls[0][0].currentEnv).toEqual({
    COCALC_CODEX_CHAT_PATH: "a.chat",
    COCALC_CODEX_THREAD_ID: "thread-a",
  });
  expect(mockSpawn.mock.calls[0][1]).toEqual(
    expect.arrayContaining(["start", "--attach", "--interactive"]),
  );
  await handle.stop();
  expect(mockExec.mock.calls[1][1]).toEqual(
    expect.arrayContaining(["rm", "--ignore", "--force"]),
  );
  expect(mockUnmount).toHaveBeenCalledTimes(1);
  expect(mockCloseLease).toHaveBeenCalledTimes(1);
  await handle.stop();
  expect(mockUnmount).toHaveBeenCalledTimes(1);
});

test("invalid bindings and profiles never start a container", async () => {
  await expect(
    launchHarnessInProject({ ...binding, projectId: ".." }),
  ).rejects.toThrow();
  await expect(
    launchHarnessInProject({
      ...binding,
      profile: { ...binding.profile, executable: "relative" },
    }),
  ).rejects.toThrow();
  expect(mockStart).not.toHaveBeenCalled();
  expect(mockExec).not.toHaveBeenCalled();
});

test("Podman stop timeout uses the existing recovery only for this sidecar", async () => {
  const handle = await launchHarnessInProject(binding);
  mockExec.mockImplementationOnce((_cmd, _args, _opts, cb) =>
    cb(Error("stop failed"), "", "given PID did not die within timeout"),
  );
  await handle.stop();
  const sidecar = mockExec.mock.calls[1][1].at(-1);
  expect(sidecar).toMatch(/^acp-/);
  expect(mockForceKill).toHaveBeenCalledWith(binding.projectId, sidecar);
  expect(mockExec.mock.calls[2][1].at(-1)).toBe(sidecar);
  expect(mockUnmount).toHaveBeenCalledTimes(1);
});

test("unrelated removal errors never trigger process-kill recovery", async () => {
  const handle = await launchHarnessInProject(binding);
  mockExec.mockImplementationOnce((_cmd, _args, _opts, cb) =>
    cb(Error("denied")),
  );
  await expect(handle.stop()).rejects.toThrow("container operation failed");
  expect(mockForceKill).not.toHaveBeenCalled();
  expect(mockUnmount).not.toHaveBeenCalled();
  await handle.stop();
});

test("ambiguous create failure attempts removal before releasing rootfs", async () => {
  mockExec.mockImplementationOnce((_cmd, _args, _opts, cb) =>
    cb(Error("secret")),
  );
  await expect(launchHarnessInProject(binding)).rejects.toThrow(
    "ACP container operation failed",
  );
  expect(mockExec).toHaveBeenCalledTimes(2);
  expect(mockUnmount).toHaveBeenCalledTimes(1);
  expect(mockSpawn).not.toHaveBeenCalled();
});

test("failed removal retains rootfs instead of unmounting under live children", async () => {
  const handle = await launchHarnessInProject(binding);
  mockExec.mockImplementationOnce((_cmd, _args, _opts, cb) =>
    cb(Error("secret")),
  );
  await expect(handle.stop()).rejects.toThrow("ACP container operation failed");
  expect(mockUnmount).not.toHaveBeenCalled();
  expect(mockCloseLease).toHaveBeenCalledTimes(1);
  await handle.stop();
  expect(mockUnmount).toHaveBeenCalledTimes(1);
});

test("missing scoped credentials fail closed before container creation", async () => {
  mockLease.mockResolvedValue(undefined);
  await expect(launchHarnessInProject(binding)).rejects.toThrow(
    "Scoped ACP CLI credentials unavailable",
  );
  expect(mockExec).not.toHaveBeenCalled();
  expect(mockUnmount).toHaveBeenCalledTimes(1);
});

test("natural exit removes its sidecar", async () => {
  const handle = await launchHarnessInProject(binding);
  proc.emit("close");
  await handle.closed;
  await handle.stop();
  expect(mockUnmount).toHaveBeenCalledTimes(1);
  expect(mockExec).toHaveBeenCalledTimes(2);
});
