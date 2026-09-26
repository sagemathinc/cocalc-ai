import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { runContainedSandboxCommand } from "./sandbox-command-containment";

const mockSpawn = jest.fn();
jest.mock("node:child_process", () => ({
  spawn: (...args) => mockSpawn(...args),
}));
jest.mock("@cocalc/backend/podman/env", () => ({
  podmanEnv: () => ({ PATH: "/usr/bin" }),
}));

function fixture() {
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
  });
  const frame = (value) => child.stdout.write(JSON.stringify(value) + "\n");
  return { child, controller, output, result, frame };
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
