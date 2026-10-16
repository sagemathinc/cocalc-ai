import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import {
  MANAGED_SANDBOX_COMMAND_SUPERVISOR,
  SANDBOX_COMMAND_LEASE_MS,
  SANDBOX_COMMAND_SUPERVISOR,
  sandboxCommandSupervisor,
} from "./sandbox-command-supervisor";

test.each(["EPERM", "ESRCH", "EIO"])(
  "a failed diagnostic probe (%s) never skips cleanup",
  (code) => {
    const child = Object.assign(new EventEmitter(), { pid: 123 });
    const kill = jest.fn((_pid, signal) => {
      if (signal === 0) throw Object.assign(Error("probe failed"), { code });
    });
    const exit = jest.fn();
    const writeSync = jest.fn();
    const clearTimer = jest.fn();
    runInNewContext(SANDBOX_COMMAND_SUPERVISOR, {
      require: (name) => {
        if (name === "node:child_process") return { spawn: () => child };
        if (name === "node:fs") return { writeSync };
        throw Error(`Unexpected module: ${name}`);
      },
      process: Object.assign(new EventEmitter(), {
        stdin: new EventEmitter(),
        argv: ["node", "command"],
        kill,
        exit,
      }),
      setInterval: () => 1,
      clearInterval: clearTimer,
    });
    expect(() => child.emit("exit", 0)).not.toThrow();
    expect(kill.mock.calls).toEqual([
      [-123, 0],
      [-123, "SIGKILL"],
    ]);
    expect(writeSync).not.toHaveBeenCalled();
    expect(clearTimer).toHaveBeenCalledWith(1);
    expect(exit).toHaveBeenCalledWith(0);
  },
);

test.each([undefined, "job-1-1-2-2-00000000-0000-4000-8000-000000000001"])(
  "managed prelude refuses an absent or mismatched cgroup (%s)",
  async (scope) => {
    const child = spawn(
      process.execPath,
      ["-e", MANAGED_SANDBOX_COMMAND_SUPERVISOR, "--", "printf must-not-run"],
      {
        env: { ...process.env, COCALC_MANAGED_JOB_SCOPE: scope },
        stdio: "pipe",
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.resume();
    const [code] = await once(child, "close");
    expect(code).toBe(125);
    expect(output).toBe("");
  },
);

function leaseHarness(supervisor: string) {
  const child = Object.assign(new EventEmitter(), { pid: 123 });
  const stdin = new EventEmitter();
  const kill = jest.fn();
  let now = 1_000_000;
  let tick: (() => void) | undefined;
  runInNewContext(supervisor, {
    require: (name) => {
      if (name === "node:child_process") return { spawn: () => child };
      throw Error(`Unexpected module: ${name}`);
    },
    process: Object.assign(new EventEmitter(), {
      stdin,
      argv: ["node", "command"],
      kill,
      exit: jest.fn(),
    }),
    Date: { now: () => now },
    setInterval: (callback: () => void) => {
      tick = callback;
      return 1;
    },
    clearInterval: () => {},
  });
  return {
    killed: () => kill.mock.calls.some(([, signal]) => signal === "SIGKILL"),
    advance: (ms: number) => {
      now += ms;
      tick?.();
    },
    heartbeat: () => stdin.emit("data", ".\n"),
  };
}

test("a host stall longer than any seen does not kill the command", () => {
  // Alpha host1, 2026-10-15: acp-worker event-loop stalls of 2-130 s under
  // disk load killed agent commands with exit 130 under the old 5 s lease.
  const longestObservedStallMs = 130_000;
  expect(SANDBOX_COMMAND_LEASE_MS).toBeGreaterThanOrEqual(
    2 * longestObservedStallMs,
  );
  const lease = leaseHarness(SANDBOX_COMMAND_SUPERVISOR);
  lease.advance(longestObservedStallMs + 5_000);
  expect(lease.killed()).toBe(false);
  lease.heartbeat();
  lease.advance(SANDBOX_COMMAND_LEASE_MS - 1_000);
  expect(lease.killed()).toBe(false);
  lease.advance(2_000);
  expect(lease.killed()).toBe(true);
});

test.each(["closed", "expired"])(
  "a %s command lease kills the shell and its sleeping child",
  async (mode) => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        sandboxCommandSupervisor(2_000),
        "--",
        'sleep 60 & echo "$!"; wait',
      ],
      { stdio: "pipe" },
    );
    const exited = once(child, "exit");
    try {
      const [chunk] = await once(child.stdout, "data");
      const pid = Number(chunk.toString().trim());
      expect(pid).toBeGreaterThan(1);
      if (mode === "closed") child.stdin.end();
      expect((await exited)[0]).toBe(130);
      const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
      expect(
        stat === "" || stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z "),
      ).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  },
  15000,
);

test.each([false, true])(
  "normal completion warns only for background leftovers (%s)",
  async (background) => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        SANDBOX_COMMAND_SUPERVISOR,
        "--",
        background ? 'sleep 60 & echo "$!"' : "printf done",
      ],
      { stdio: "pipe" },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    try {
      const [code] = await once(child, "close");
      expect(code).toBe(0);
      expect(stderr.includes("use cocalc project terminal spawn")).toBe(
        background,
      );
      if (background) {
        const stat = await readFile(
          `/proc/${Number(stdout.trim())}/stat`,
          "utf8",
        ).catch(() => "");
        expect(
          stat === "" || stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z "),
        ).toBe(true);
      }
    } finally {
      child.kill("SIGKILL");
    }
  },
);
