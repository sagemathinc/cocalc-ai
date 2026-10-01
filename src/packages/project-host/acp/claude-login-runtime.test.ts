import { execFile, spawn } from "node:child_process";
import {
  claudeLoginContainerArgs,
  claudeLoginContainerName,
  createClaudeLoginRuntime,
  stopClaudeLoginContainers,
} from "./claude-login-runtime";

jest.mock("node:child_process", () => {
  const actual = jest.requireActual("node:child_process");
  const mock = jest.fn();
  const { promisify } = jest.requireActual("node:util");
  Object.defineProperty(mock, promisify.custom, {
    value: (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        mock(...args, (error: Error | null, stdout: string, stderr: string) =>
          error ? reject(error) : resolve({ stdout, stderr }),
        );
      }),
  });
  return { ...actual, execFile: mock, spawn: jest.fn() };
});
jest.mock("@cocalc/backend/podman/env", () => ({
  podmanEnv: () => ({ PATH: "/usr/bin:/bin" }),
}));
jest.mock("@cocalc/project-runner/run/rootfs-base", () => ({
  extractBaseImage: async () => "/private/rootfs",
}));
jest.mock("@cocalc/project-runner/run/podman", () => ({
  podmanRuntimeArgs: async () => ["--runtime=crun"],
  projectPoolPodmanLauncher: () => ({
    command: "project-pool",
    argsPrefix: ["podman"],
  }),
}));

const binding = {
  projectId: "3807103b-f2f9-4ced-8885-eeb442d623b7",
  holder: "2900a1aa-219a-4b6c-879c-0154d4096a70",
  home: "/private/login",
  runtimeId: "123:45ce48bc-54a8-466b-936f-7c48b0f45a16:789",
};
const cliPath = "/opt/cocalc/harnesses/claude-code/version/native/claude";
const calls: { command: string; args: string[] }[] = [];
let fail: ((command: string, args: string[]) => boolean) | undefined;
let snapshot = "";

beforeEach(() => {
  jest.clearAllMocks();
  calls.length = 0;
  fail = undefined;
  snapshot = "";
  jest.mocked(execFile).mockImplementation(((
    command: string,
    args: string[],
    _options: unknown,
    callback: Function,
  ) => {
    calls.push({ command, args });
    callback(
      fail?.(command, args) ? Error("private provider output") : null,
      command === "ps"
        ? snapshot
        : args.includes("start")
          ? "verified fixture status"
          : "",
      "",
    );
    return {};
  }) as typeof execFile);
  jest.mocked(spawn).mockImplementation((() => ({})) as typeof spawn);
});

test("private PID namespace mounts only the native home and read-only managed runtime", () => {
  const args = claudeLoginContainerArgs({
    binding,
    phase: "login",
    rootfs: "/private/rootfs",
    managedHarnesses: "/opt/cocalc/harnesses",
    cliRelativePath: "claude-code/version/native/claude",
    runtimeArgs: [],
    uid: 1000,
    gid: 1000,
  });
  expect(args).toContain("--read-only");
  expect(args).toContain("--cap-drop=all");
  expect(args).not.toContain("--pid=host");
  expect(args.filter((arg) => arg.startsWith("--mount="))).toEqual([
    "--mount=type=bind,source=/private/login/native,target=/home/claude,rw",
    "--mount=type=bind,source=/opt/cocalc/harnesses,target=/opt/cocalc/harnesses,ro",
  ]);
  expect(args.slice(-4)).toEqual([
    "/opt/cocalc/harnesses/claude-code/version/native/claude",
    "auth",
    "login",
    "--claudeai",
  ]);
  expect(args.join(" ")).not.toMatch(
    /ANTHROPIC_API_KEY|COCALC_BEARER_TOKEN|\.cocalc-login/,
  );
  expect(() =>
    claudeLoginContainerArgs({
      binding,
      phase: "login",
      rootfs: "/r",
      managedHarnesses: "/h",
      cliRelativePath: "../escape",
      runtimeArgs: [],
      uid: 1,
      gid: 1,
    }),
  ).toThrow("Invalid");
  expect(() =>
    claudeLoginContainerName({ ...binding, holder: "bad" }, "login"),
  ).toThrow("Invalid");
});

test("create acknowledges before attached start; a late create cannot run native auth", async () => {
  await createClaudeLoginRuntime(cliPath).launch(binding);
  expect(calls[0].args[1]).toBe("create");
  expect(spawn).toHaveBeenCalledWith(
    "project-pool",
    [
      "podman",
      "start",
      "--attach",
      "--interactive",
      claudeLoginContainerName(binding, "login"),
    ],
    expect.any(Object),
  );
  fail = (_command, args) => args.includes("create");
  jest.mocked(spawn).mockClear();
  await expect(
    createClaudeLoginRuntime(cliPath).launch(binding),
  ).rejects.toThrow("container operation failed");
  expect(spawn).not.toHaveBeenCalled();
});

test("status removes login first, runs separately, and removes status before returning", async () => {
  await expect(createClaudeLoginRuntime(cliPath).status(binding)).resolves.toBe(
    "verified fixture status",
  );
  const operations = calls
    .filter((call) => call.command !== "ps")
    .map(
      (call) =>
        call.args.filter((arg) => ["rm", "create", "start"].includes(arg))[0],
    );
  expect(operations).toEqual(["rm", "rm", "create", "start", "rm", "rm"]);
});

test.each(["rm", "ps"])(
  "uncertain %s fails closed without exposing provider output",
  async (operation) => {
    fail = (command, args) => command === operation || args.includes(operation);
    await expect(stopClaudeLoginContainers(binding)).rejects.toThrow(
      /unconfirmed|operation failed/,
    );
    await expect(stopClaudeLoginContainers(binding)).rejects.not.toThrow(
      "private provider output",
    );
  },
);

test("an orphaned conmon prevents a false absent-container shutdown proof", async () => {
  snapshot = `100 1 /usr/bin/conmon --api-version 1 -n ${claudeLoginContainerName(binding, "login")}\n101 100 /native-grandchild\n`;
  await expect(stopClaudeLoginContainers(binding)).rejects.toThrow(
    "unconfirmed",
  );
});

test("status failure still removes its namespace and never returns native output", async () => {
  fail = (_command, args) => args.includes("start");
  await expect(
    createClaudeLoginRuntime(cliPath).status(binding),
  ).rejects.toThrow("container operation failed");
  expect(calls.filter((call) => call.args.includes("rm"))).toHaveLength(4);
});
