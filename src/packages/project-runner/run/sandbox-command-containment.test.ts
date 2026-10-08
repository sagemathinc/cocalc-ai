import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  containedPodmanEnv,
  runContainedSandboxCommand,
} from "./sandbox-command-containment";

const mockSpawn = jest.fn();
const mockExecFile = jest.fn();
jest.mock("node:child_process", () => ({
  spawn: (...args) => mockSpawn(...args),
  execFile: (...args) => mockExecFile(...args),
}));
jest.mock("@cocalc/backend/podman/env", () => ({
  podmanEnv: () => ({ PATH: "/usr/bin" }),
}));

function fixture(onCleanupConfirmed?: () => void) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: jest.fn(),
  });
  mockSpawn.mockReturnValue(child);
  const controller = new AbortController();
  const output = jest.fn();
  const result = runContainedSandboxCommand({
    project_id: "00000000-0000-4000-8000-000000000001",
    args: ["exec", "project-fixture", "command"],
    signal: controller.signal,
    timeoutMs: 10000,
    onOutput: output,
    onCleanupConfirmed,
  });
  const frame = (value) => child.stdout.write(JSON.stringify(value) + "\n");
  const jobId = mockSpawn.mock.calls.at(-1)[1][4];
  const scope = `job-${process.pid}-1-42-2-999999999999-${jobId}`;
  return { child, controller, output, result, frame, scope };
}

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

test("uses the trusted helper and requires its final cleanup proof", async () => {
  const { child, result, frame, output } = fixture();
  expect(mockSpawn.mock.calls[0][0]).toBe("sudo");
  expect(mockSpawn.mock.calls[0][1]).toContain("supervise-project-job");
  frame({
    type: "output",
    stream: "stdout",
    data: Buffer.from("build\n").toString("base64"),
  });
  frame({ type: "exit", code: 7, cleanup: true });
  child.emit("close", 0);
  expect(await result).toMatchObject({ code: 7, cleanupConfirmed: true });
  expect(output).toHaveBeenCalledWith("stdout", "build\n");
});

test("project output cannot forge cleanup proof; transport success is not cleanup", async () => {
  const { child, result, frame } = fixture();
  frame({
    type: "output",
    stream: "stdout",
    data: Buffer.from('{"type":"exit","code":0,"cleanup":true}\n').toString(
      "base64",
    ),
  });
  child.emit("close", 0);
  expect(await result).toMatchObject({ code: null, cleanupConfirmed: false });
});

test("cancel ends the lease; a killed transport never claims cleanup", async () => {
  jest.useFakeTimers();
  const { child, result, controller } = fixture();
  controller.abort();
  expect(child.stdin.writableEnded).toBe(true);
  await jest.advanceTimersByTimeAsync(20000);
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  child.emit("close", null, "SIGKILL");
  expect(await result).toMatchObject({ cleanupConfirmed: false });
});

test("deadline ends the lease and waits for authoritative cleanup", async () => {
  jest.useFakeTimers();
  const { child, result, frame } = fixture();
  await jest.advanceTimersByTimeAsync(10000);
  expect(child.stdin.writableEnded).toBe(true);
  frame({ type: "exit", code: 130, cleanup: true });
  child.emit("close", 0);
  expect(await result).toMatchObject({ code: 130, cleanupConfirmed: true });
});

test("malformed, truncated and post-proof frames fail closed", async () => {
  for (const payload of [
    "not-json\n",
    '{"type":',
    '{"type":"exit","code":0,"cleanup":true}\n{}\n',
  ]) {
    const { child, result } = fixture();
    child.stdout.write(payload);
    child.emit("close", 0);
    expect(await result).toMatchObject({ cleanupConfirmed: false });
  }
});

test("UTF-8 is decoded across independently framed byte chunks", async () => {
  const { child, result, frame, output } = fixture();
  const bytes = Buffer.from("\u{1F600}");
  for (const byte of bytes)
    frame({
      type: "output",
      stream: "stdout",
      data: Buffer.from([byte]).toString("base64"),
    });
  frame({ type: "exit", code: 0, cleanup: true });
  child.emit("close", 0);
  await result;
  expect(output.mock.calls.map((call) => call[1]).join("")).toBe("\u{1F600}");
});

test("missing helper cannot fall back to unsupervised execution", async () => {
  const { child, result } = fixture();
  child.emit("error", Error("missing helper"));
  child.emit("close", 1);
  expect(await result).toMatchObject({ cleanupConfirmed: false, code: null });
  expect(mockSpawn).toHaveBeenCalledTimes(1);
});

test("cancellation before admission needs no scope and does not spawn", async () => {
  const abort = new AbortController();
  abort.abort();
  expect(
    await runContainedSandboxCommand({
      project_id: "fixture",
      args: [],
      signal: abort.signal,
      timeoutMs: 1000,
      onOutput: jest.fn(),
    }),
  ).toMatchObject({ code: 130, cleanupConfirmed: true });
  expect(mockSpawn).not.toHaveBeenCalled();
});

test("recovery requires an exact trusted proof and retries errors without secrets", async () => {
  jest.useFakeTimers();
  const confirmed = jest.fn();
  const { child, result, frame, scope } = fixture(confirmed);
  frame({ type: "scope", scope });
  child.emit("close", 1);
  expect(await result).toMatchObject({ cleanupConfirmed: false });
  const proof = { project_id: "00000000-0000-4000-8000-000000000001", scope };
  const responses = [
    [
      Error("privileged diagnostic must not escape"),
      JSON.stringify({ confirmed: [proof] }),
    ],
    [null, ""], // An old/missing helper or mere exit success is not a proof.
    [null, '{"confirmed":[]}'],
    [null, '{"confirmed":'],
    [
      null,
      JSON.stringify({
        confirmed: [{ ...proof, project_id: "another-project" }],
      }),
    ],
    [
      null,
      JSON.stringify({
        confirmed: [{ ...proof, scope: scope.replace("-42-", "-43-") }],
      }),
    ],
    [null, JSON.stringify({ confirmed: [proof] })],
  ];
  mockExecFile.mockImplementation((command, args, options, callback) => {
    expect(command).toBe("sudo");
    expect(args).toEqual([
      "-n",
      "/usr/local/sbin/cocalc-runtime-storage",
      "confirm-project-job-cleanup",
    ]);
    expect(options).toMatchObject({ timeout: 30_000, maxBuffer: 65536 });
    const stdin = new PassThrough();
    stdin.on("data", (data) => {
      expect(JSON.parse(data.toString())).toEqual({ jobs: [proof] });
      callback(...responses.shift()!);
    });
    return { stdin };
  });
  // The first check runs soon after the job, then every 30 seconds.
  await jest.advanceTimersByTimeAsync(5_000);
  expect(mockExecFile).toHaveBeenCalledTimes(1);
  expect(confirmed).not.toHaveBeenCalled();
  for (let i = 0; i < 5; i++) {
    await jest.advanceTimersByTimeAsync(30_000);
    expect(confirmed).not.toHaveBeenCalled();
  }
  await jest.advanceTimersByTimeAsync(30_000);
  expect(confirmed).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(60_000);
  expect(mockExecFile).toHaveBeenCalledTimes(7);
});

test("untrusted output and mismatched scope identities cannot obtain a recovery handle", async () => {
  jest.useFakeTimers();
  for (const mode of ["output", "owner", "job"]) {
    const confirmed = jest.fn();
    const { child, result, frame, scope } = fixture(confirmed);
    if (mode === "output")
      frame({
        type: "output",
        stream: "stdout",
        data: Buffer.from(JSON.stringify({ type: "scope", scope })).toString(
          "base64",
        ),
      });
    else
      frame({
        type: "scope",
        scope:
          mode === "owner"
            ? scope.replace(`job-${process.pid}-`, "job-0-")
            : scope.slice(0, -1) + "x",
      });
    child.emit("close", 0);
    expect(await result).toMatchObject({ cleanupConfirmed: false });
    await jest.advanceTimersByTimeAsync(30_000);
    expect(confirmed).not.toHaveBeenCalled();
  }
  expect(mockExecFile).not.toHaveBeenCalled();
});

test("recovery polling never overlaps a stalled privileged query", async () => {
  jest.useFakeTimers();
  const confirmed = jest.fn();
  const { child, result, frame, scope } = fixture(confirmed);
  frame({ type: "scope", scope });
  child.emit("close", 1);
  await result;
  let finish: () => void;
  mockExecFile.mockImplementation((_command, _args, _options, callback) => {
    const stdin = new PassThrough();
    stdin.on("data", (data) => {
      finish = () =>
        callback(
          null,
          JSON.stringify({ confirmed: JSON.parse(data.toString()).jobs }),
        );
    });
    return { stdin };
  });
  await jest.advanceTimersByTimeAsync(90_000);
  expect(mockExecFile).toHaveBeenCalledTimes(1);
  expect(confirmed).not.toHaveBeenCalled();
  finish!();
  await jest.advanceTimersByTimeAsync(30_000);
  expect(confirmed).toHaveBeenCalledTimes(1);
  expect(mockExecFile).toHaveBeenCalledTimes(1);
});

test("contained Podman cannot move itself into the user's systemd session", () => {
  expect(containedPodmanEnv()).toEqual({
    PATH: "/usr/bin",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/dev/null/cocalc-no-user-bus",
  });
});
