/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { connect } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SandboxExecResult } from "@cocalc/project-runner/run/sandbox-exec";
import {
  ClaudeProjectJobs,
  type ProjectJobExecutor,
} from "./claude-project-jobs";
import { createClaudeProjectToolBridge } from "./claude-project-tool-bridge";

const tools: [string, Record<string, unknown>][] = [
  ["project_exec", { script: "true" }],
  ["project_read_file", { path: "notes.txt" }],
  ["project_write_file", { path: "notes.txt", content: "new" }],
  [
    "project_edit_file",
    { path: "notes.txt", old_string: "old", new_string: "new" },
  ],
  ["project_read_image", { path: "plot.png" }],
  ["memory_list", {}],
  ["memory_read", { name: "notes" }],
  ["memory_write", { name: "notes", description: "notes", body: "new" }],
  ["memory_delete", { name: "notes" }],
];
const ok: SandboxExecResult = {
  code: 0,
  stdout: "",
  stderr: "",
  cleanupConfirmed: true,
};

async function request(
  directory: string,
  tool: string,
  args: Record<string, unknown>,
) {
  const token = await readFile(join(directory, "token"), "utf8");
  return new Promise<any>((resolve, reject) => {
    const socket = connect(join(directory, "tool.sock"));
    let response = "";
    socket.setEncoding("utf8");
    socket.on("error", reject);
    socket.on("connect", () =>
      socket.write(JSON.stringify({ token, tool, args }) + "\n"),
    );
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("end", () => {
      try {
        resolve(JSON.parse(response));
      } catch (error) {
        reject(error);
      }
    });
  });
}

describe.each(["unconfirmed", "missing", "rejected"])(
  "%s cleanup",
  (failure) => {
    test.each(tools)(
      "%s fences every other execution tool, even after resume",
      async (tool, args) => {
        let confirm = () => {};
        const execute: ProjectJobExecutor = jest.fn(
          async (_script, _cwd, _signal, options) => {
            confirm = options.onCleanupConfirmed;
            if (failure === "rejected") throw Error("executor failed");
            return {
              ...ok,
              cleanupConfirmed: failure === "missing" ? undefined : false,
            };
          },
        );
        const bridge = await createClaudeProjectToolBridge("fixture", execute);
        try {
          const first = await request(bridge.directory, tool, args);
          if (tool === "project_exec") expect(first.cleanup_pending).toBe(true);
          else expect(first.stderr).toContain("cleanup is unconfirmed");
          await bridge.cancel();
          bridge.resume();
          for (const [next, nextArgs] of tools) {
            expect(
              (await request(bridge.directory, next, nextArgs)).stderr,
            ).toContain("cleanup is unconfirmed");
          }
          expect(execute).toHaveBeenCalledTimes(1);
          // A trusted late proof that the job's processes are gone reopens
          // the session: the next tool runs again (and here fences again,
          // because this executor never confirms cleanup).
          confirm();
          bridge.resume();
          await request(bridge.directory, "memory_list", {});
          expect(execute).toHaveBeenCalledTimes(2);
        } finally {
          confirm();
          await bridge.close();
        }
      },
    );
  },
);

test.each(["project_write_file", "project_edit_file"])(
  "%s stops before further chunks/rename after cleanup failure",
  async (tool) => {
    const proofs: (() => void)[] = [];
    const execute = jest.fn<
      ReturnType<ProjectJobExecutor>,
      Parameters<ProjectJobExecutor>
    >(async (_script, _cwd, _signal, options) => {
      proofs.push(options.onCleanupConfirmed);
      if (proofs.length === 1)
        return {
          ...ok,
          stdout:
            tool === "project_write_file"
              ? "/home/user/notes.txt\n"
              : `/home/user/notes.txt\n${Buffer.from("old").toString("base64")}`,
        };
      return { ...ok, cleanupConfirmed: false };
    });
    const bridge = await createClaudeProjectToolBridge("fixture", execute);
    try {
      const result = await request(bridge.directory, tool, {
        path: "notes.txt",
        content: "x".repeat(200_000),
        old_string: "old",
        new_string: "x".repeat(200_000),
      });
      expect(result.stderr).toContain("cleanup is unconfirmed");
      expect(execute).toHaveBeenCalledTimes(2);
      expect(execute.mock.calls[1][0]).toContain("base64 -d");
      expect(execute.mock.calls[1][0]).not.toContain("mv -f");
    } finally {
      proofs.forEach((confirm) => confirm());
      await bridge.close();
    }
  },
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const runs: {
    signal: AbortSignal;
    options: Parameters<ProjectJobExecutor>[3];
    finish: (value: SandboxExecResult) => void;
  }[] = [];
  const execute = jest.fn(
    async (
      _script: string,
      _cwd: string | undefined,
      signal: AbortSignal,
      options: Parameters<ProjectJobExecutor>[3],
    ) => {
      const result = deferred<SandboxExecResult>();
      runs.push({ signal, options, finish: result.resolve });
      return result.promise;
    },
  );
  const jobs = new ClaudeProjectJobs(execute);
  const tool = (signal = new AbortController().signal, timeoutMs = 30_000) =>
    jobs.executeTool("tool", undefined, signal, {
      timeoutMs,
      onOutput: () => {},
      onCleanupConfirmed: () => {},
    });
  const close = async () => {
    for (const run of runs) {
      run.finish(ok);
      run.options.onCleanupConfirmed();
    }
    await jobs.close();
  };
  return { jobs, runs, execute, tool, close };
}

test.each([0, 1])(
  "commands and synchronous tools cancel siblings when execution %i fails cleanup",
  async (failed) => {
    const { jobs, runs, execute, tool, close } = fixture();
    const results: Promise<unknown>[] = [];
    try {
      const command = await jobs.start({ script: "command", yield_time_ms: 0 });
      for (let i = 0; i < 3; i++) results.push(tool().catch((error) => error));
      await Promise.resolve();
      expect(jobs.running).toBe(true);
      expect(jobs.list().jobs).toHaveLength(1);
      expect(execute).toHaveBeenCalledTimes(4);
      runs[failed].finish({ ...ok, cleanupConfirmed: false });
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (failed === 1)
        expect(await results[0]).toEqual(
          expect.objectContaining({
            message: expect.stringContaining("cleanup is unconfirmed"),
          }),
        );
      expect(runs[failed === 0 ? 1 : 0].signal.aborted).toBe(true);
      expect(runs[2].signal.aborted).toBe(true);
      expect(runs[3].signal.aborted).toBe(true);
      expect(
        await jobs.wait({ job_id: command.job_id, yield_time_ms: 0 }),
      ).toMatchObject({
        status: failed === 0 ? "failed" : "canceled",
        cleanup_pending: true,
      });
    } finally {
      await close();
      await Promise.all(results);
    }
  },
);

test("tool steps neither consume nor require the four background command slots", async () => {
  const { jobs, runs, tool, close } = fixture();
  const results: Promise<unknown>[] = [];
  try {
    for (let i = 0; i < 3; i++)
      await jobs.start({ script: `command ${i}`, yield_time_ms: 0 });
    for (let i = 0; i < 5; i++) results.push(tool().catch((error) => error));
    await jobs.start({ script: "fourth command", yield_time_ms: 0 });
    await expect(
      jobs.start({ script: "fifth command", yield_time_ms: 0 }),
    ).rejects.toThrow("Four");
    const atCapacity = tool();
    results.push(atCapacity);
    await Promise.resolve();
    expect(jobs.list().jobs).toHaveLength(4);
    expect(runs).toHaveLength(10);
    runs[9].finish(ok);
    await expect(atCapacity).resolves.toEqual(ok);
  } finally {
    await close();
    await Promise.all(results);
  }
});

test("tool steps in one session retain the 64-execution host limit", async () => {
  const { runs, tool, close } = fixture();
  const results: Promise<unknown>[] = [];
  try {
    for (let i = 0; i < 64; i++) results.push(tool().catch((error) => error));
    await expect(tool()).rejects.toThrow("host command capacity");
    await Promise.resolve();
    expect(runs).toHaveLength(64);
    runs[0].finish(ok);
    await results[0];
    const next = tool();
    results.push(next);
    await Promise.resolve();
    expect(runs).toHaveLength(65);
    runs[64].finish(ok);
    await expect(next).resolves.toEqual(ok);
  } finally {
    await close();
    await Promise.all(results);
  }
});

test("transient tools do not exhaust or evict retained command history", async () => {
  const { jobs, runs, tool, close } = fixture();
  const results: Promise<unknown>[] = [];
  try {
    for (let i = 0; i < 32; i++) {
      const command = await jobs.start({
        script: `command ${i}`,
        yield_time_ms: 0,
      });
      runs[i].finish(ok);
      await jobs.wait({ job_id: command.job_id, yield_time_ms: 1000 });
    }
    const history = jobs.list().jobs;
    expect(history).toHaveLength(32);
    for (let i = 0; i < 32; i++) results.push(tool().catch((error) => error));
    await Promise.resolve();
    expect(runs).toHaveLength(64);
    expect(jobs.list().jobs).toEqual(history);
    await jobs.start({ script: "new command", yield_time_ms: 0 });
    expect(runs).toHaveLength(65);
    expect(jobs.list().jobs).toHaveLength(32);
  } finally {
    await close();
    await Promise.all(results);
  }
});

test.each(["cancel", "close", "signal", "deadline"])(
  "%s aborts synchronous tools and retains their reservation until settlement",
  async (action) => {
    jest.useFakeTimers();
    const { jobs, runs, tool, close } = fixture();
    const controller = new AbortController();
    const result = tool(controller.signal, 100).catch((error) => error);
    let stopped = false;
    let stopping = Promise.resolve();
    try {
      await Promise.resolve();
      expect(jobs.running).toBe(true);
      if (action === "signal") controller.abort();
      else if (action === "deadline") await jest.advanceTimersByTimeAsync(100);
      else
        stopping = (action === "close" ? jobs.close() : jobs.cancelAll()).then(
          () => {
            stopped = true;
          },
        );
      expect(runs[0].signal.aborted).toBe(true);
      await Promise.resolve();
      expect(stopped).toBe(false);
      runs[0].finish(ok);
      expect(await result).toMatchObject({ name: "AbortError" });
      await stopping;
      jobs.resume();
      if (action === "close") await expect(tool()).rejects.toThrow("closed");
      else {
        const next = tool();
        await Promise.resolve();
        runs[1].finish(ok);
        expect(await next).toEqual(ok);
      }
    } finally {
      await close();
      jest.useRealTimers();
    }
  },
);

test("cancel before executor entry does not execute or poison the resumed session", async () => {
  const { jobs, runs, execute, tool, close } = fixture();
  try {
    const controller = new AbortController();
    controller.abort();
    await expect(tool(controller.signal)).rejects.toThrow();
    const result = tool().catch((error) => error);
    await jobs.cancelAll();
    expect(await result).toMatchObject({ name: "AbortError" });
    expect(execute).not.toHaveBeenCalled();
    jobs.resume();
    const next = tool();
    await Promise.resolve();
    runs[0].finish(ok);
    expect(await next).toEqual(ok);
  } finally {
    await close();
  }
});

test("synchronous tools hold host capacity after close until exact late cleanup proofs", async () => {
  const fixtures = Array.from({ length: 65 }, fixture);
  try {
    for (let i = 0; i < 64; i++) {
      const f = fixtures[i];
      const result = f.tool().catch((error) => error);
      await Promise.resolve();
      f.runs[0].finish({ ...ok, cleanupConfirmed: false });
      expect(await result).toBeInstanceOf(Error);
      await f.jobs.close();
    }
    const healthy = fixtures[64];
    await expect(healthy.tool()).rejects.toThrow("capacity reached");
    await expect(healthy.jobs.start({ script: "command" })).rejects.toThrow(
      "capacity reached",
    );
    fixtures[0].runs[0].options.onCleanupConfirmed();
    fixtures[0].runs[0].options.onCleanupConfirmed();
    const admitted = healthy.tool();
    await Promise.resolve();
    await expect(healthy.tool()).rejects.toThrow("capacity reached");
    healthy.runs[0].finish(ok);
    await admitted;
    // The proof lifts the fence, but a closed controller stays closed.
    fixtures[0].jobs.resume();
    await expect(fixtures[0].tool()).rejects.toThrow("Project tool is closed");
    fixtures[1].jobs.resume();
    await expect(fixtures[1].tool()).rejects.toThrow("cleanup is unconfirmed");
  } finally {
    for (const f of fixtures) await f.close();
  }
});

test("successful tool steps release capacity, preserve output, and do not fill command history", async () => {
  const output = "x".repeat(800_000);
  const execute: ProjectJobExecutor = async (
    _script,
    _cwd,
    _signal,
    options,
  ) => {
    options.onOutput("stdout", output);
    return { ...ok, code: 7 };
  };
  const jobs = new ClaudeProjectJobs(execute);
  try {
    for (let i = 0; i < 40; i++) {
      const onOutput = jest.fn();
      expect(
        await jobs.executeTool(
          "step",
          undefined,
          new AbortController().signal,
          {
            timeoutMs: 30_000,
            onOutput,
            onCleanupConfirmed: () => {},
          },
        ),
      ).toMatchObject({ code: 7 });
      expect(onOutput).toHaveBeenCalledWith("stdout", output);
    }
    expect(jobs.list().jobs).toEqual([]);
    expect(jobs.running).toBe(false);
  } finally {
    await jobs.close();
  }
});

test("early cleanup proofs and caller abort do not free capacity before executor settlement", async () => {
  const { jobs, runs, tool, close } = fixture();
  const controller = new AbortController();
  const results = Array.from({ length: 64 }, () =>
    tool(controller.signal).catch((error) => error),
  );
  try {
    await Promise.resolve();
    for (const run of runs) run.options.onCleanupConfirmed();
    controller.abort();
    await expect(tool()).rejects.toThrow("host command capacity");
    runs[0].finish(ok);
    expect(await results[0]).toMatchObject({ name: "AbortError" });
    const next = tool();
    await Promise.resolve();
    runs[64].finish(ok);
    expect(await next).toEqual(ok);
    expect(jobs.running).toBe(false);
  } finally {
    await close();
    await Promise.all(results);
  }
});

test("a bridge authorization failure drains synchronous tools before allowing a new generation", async () => {
  const entered = deferred<void>();
  const settled = deferred<SandboxExecResult>();
  let signal!: AbortSignal;
  const execute = jest.fn(async (_script, _cwd, current) => {
    signal = current;
    entered.resolve();
    return settled.promise;
  });
  const authorize = jest.fn(async () => {});
  const bridge = await createClaudeProjectToolBridge(
    "fixture",
    execute,
    authorize,
  );
  const first = request(bridge.directory, "memory_list", {});
  try {
    await entered.promise;
    authorize.mockRejectedValueOnce(Error("revoked"));
    const denied = request(bridge.directory, "project_exec", {
      script: "true",
    });
    // The denied request aborts the running tool, but waits for its cleanup.
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    let deniedSettled = false;
    void denied.then(() => {
      deniedSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(deniedSettled).toBe(false);
    settled.resolve(ok);
    expect((await denied).stderr).toBe("revoked");
    expect((await first).code).toBeNull();
    execute.mockResolvedValueOnce({
      ...ok,
      stdout: '{"ok":true,"data":{"notes":[]}}',
    });
    expect(await request(bridge.directory, "memory_list", {})).toEqual({
      notes: [],
    });
    expect(execute).toHaveBeenCalledTimes(2);
  } finally {
    settled.resolve(ok);
    await first;
    await bridge.close();
  }
});
