import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { launchHarnessInProject } from "./harness-launcher";

const mockExec = jest.fn();
const mockSpawn = jest.fn();
const mockUnmount = jest.fn();
const mockStart = jest.fn();
jest.mock("node:child_process", () => ({
  execFile: (...args) => mockExec(...args),
  spawn: (...args) => mockSpawn(...args),
}));
jest.mock("node:fs/promises", () => ({ readFile: async () => "image" }));
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
  }),
}));
jest.mock("@cocalc/project-runner/run/mounts", () => ({
  getCoCalcMounts: () => ({ "/cocalc": "/opt/cocalc" }),
}));
jest.mock("@cocalc/project-runner/run/podman", () => ({
  podmanRuntimeArgs: async () => [],
  projectPoolPodmanLauncher: () => ({
    command: "pool-launcher",
    argsPrefix: ["project-pool", "podman"],
  }),
}));
jest.mock("../codex/codex-project", () => ({
  ensureProjectContainerRunning: (...args) => mockStart(...args),
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
  expect(mockSpawn.mock.calls[0][1]).toEqual(
    expect.arrayContaining(["start", "--attach", "--interactive"]),
  );
  await handle.stop();
  expect(mockExec.mock.calls[1][1]).toEqual(
    expect.arrayContaining(["rm", "--ignore", "--force"]),
  );
  expect(mockUnmount).toHaveBeenCalledTimes(1);
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
});

test("natural exit removes its sidecar", async () => {
  const handle = await launchHarnessInProject(binding);
  proc.emit("close");
  await handle.closed;
  await handle.stop();
  expect(mockUnmount).toHaveBeenCalledTimes(1);
  expect(mockExec).toHaveBeenCalledTimes(2);
});
