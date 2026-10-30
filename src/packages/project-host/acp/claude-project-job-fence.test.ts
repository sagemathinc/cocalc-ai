/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { runContainedSandboxCommand } from "@cocalc/project-runner/run/sandbox-command-containment";
import {
  createRenewableCliLease,
  leasedProjectExecutor,
} from "./claude-cli-lease";
import { ClaudeProjectJobs } from "./claude-project-jobs";

// These tests are about the fence itself: a fenced call fails at once (the
// bounded wait for a brief fence has its own tests).
process.env.COCALC_PROJECT_TOOL_FENCE_WAIT_MS = "0";

const mockSpawn = jest.fn();
const mockExecFile = jest.fn();
jest.mock("node:child_process", () => ({
  spawn: (...args) => mockSpawn(...args),
  execFile: (...args) => mockExecFile(...args),
}));
jest.mock("@cocalc/backend/podman/env", () => ({
  podmanEnv: () => ({ PATH: "/usr/bin" }),
}));

const PROJECT = "00000000-0000-4000-8000-000000000001";

// Alpha host1, 2026-10-28 15:38Z: a cancelled job's helper could not take
// the lifecycle lock for its cleanup, so it exited without a cleanup proof;
// the runtime's recovery proved it 30 s later, but the agent's project
// tools stayed fenced until a new controller session.
test("a cancel while maintenance holds the lock reopens tools on the late proof", async () => {
  jest.useFakeTimers();
  const children: any[] = [];
  const scopes: string[] = [];
  const gone = new Set<string>();
  mockSpawn.mockImplementation((_cmd, args) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: jest.fn(),
    });
    scopes.push(`job-${process.pid}-1-42-2-999999999999-${args[4]}`);
    children.push(child);
    return child;
  });
  mockExecFile.mockImplementation((_cmd, args, _options, callback) => {
    expect(args).toContain("confirm-project-job-cleanup");
    const stdin = new PassThrough();
    stdin.on("data", (data) => {
      const { jobs } = JSON.parse(data.toString());
      callback(
        null,
        JSON.stringify({
          confirmed: jobs.filter((job) => gone.has(job.scope)),
        }),
      );
    });
    return { stdin };
  });
  const leases = createRenewableCliLease(async () => ({
    close: async () => {},
  }));
  const jobs = new ClaudeProjectJobs(
    leasedProjectExecutor({
      leases,
      envFor: () => ({}),
      execute: (_env, _script, _cwd, signal, options) =>
        runContainedSandboxCommand({
          project_id: PROJECT,
          args: ["exec", "fixture"],
          signal,
          ...options,
        }),
    }),
  );
  try {
    const grep = await jobs.start({ script: "grep -r", yield_time_ms: 0 });
    await jest.advanceTimersByTimeAsync(0);
    children[0].stdout.write(
      JSON.stringify({ type: "scope", scope: scopes[0] }) + "\n",
    );
    const cancel = jobs.cancel({ job_id: grep.job_id });
    // The helper's cleanup may take the lock wait (15 s) and the scope kill
    // (10 s) within its 30 s output drain: never force-kill sudo inside that.
    await jest.advanceTimersByTimeAsync(31_000);
    expect(children[0].kill).not.toHaveBeenCalled();
    // Here it gave up on the lock and exited without an exit frame.
    children[0].emit("close", 1);
    expect(await cancel).toMatchObject({
      status: "canceled",
      cleanup_pending: true,
      cleanup_error: "Runtime could not verify job cleanup",
    });
    await expect(jobs.start({ script: "true" })).rejects.toThrow(
      "cleanup is unconfirmed",
    );
    // The first recheck (5 s) finds the scope still there.
    await jest.advanceTimersByTimeAsync(5_000);
    await expect(jobs.start({ script: "true" })).rejects.toThrow(
      "cleanup is unconfirmed",
    );
    // The orphan sweep removes it; the next recheck proves it.
    gone.add(scopes[0]);
    await jest.advanceTimersByTimeAsync(25_000);
    expect(jobs.list().jobs[0]).toMatchObject({
      job_id: grep.job_id,
      cleanup_pending: false,
      cleanup_error: undefined,
    });
    const next = await jobs.start({ script: "true", yield_time_ms: 0 });
    expect(next.status).toBe("running");
    // A fresh lease, then the helper.
    await jest.advanceTimersByTimeAsync(0);
    children[1].stdout.write(
      JSON.stringify({ type: "scope", scope: scopes[1] }) + "\n",
    );
    children[1].stdout.write('{"type":"exit","code":0,"cleanup":true}\n');
    children[1].emit("close", 0);
  } finally {
    gone.clear();
    for (const child of children) child.emit("close", null);
    mockExecFile.mockImplementation((_cmd, _args, _options, callback) => {
      const stdin = new PassThrough();
      stdin.on("data", (data) =>
        callback(
          null,
          JSON.stringify({ confirmed: JSON.parse(data.toString()).jobs }),
        ),
      );
      return { stdin };
    });
    await jest.advanceTimersByTimeAsync(30_000);
    await jobs.close();
    jest.useRealTimers();
  }
});

test("a peer stopped by the fence before it ran does not hold the fence", async () => {
  let finishFirst!: (result: any) => void;
  let proveFirst!: () => void;
  const executed: string[] = [];
  const jobs = new ClaudeProjectJobs((script, _cwd, _signal, options) => {
    executed.push(script);
    proveFirst = options.onCleanupConfirmed;
    return new Promise((resolve) => (finishFirst = resolve));
  });
  await jobs.start({ script: "first", yield_time_ms: 0 });
  // The first job's unconfirmed result and a new command arrive together:
  // the fence goes up before the new command reaches the executor.
  finishFirst({ stdout: "", stderr: "", code: null, cleanupConfirmed: false });
  // One tick later the first job's result handler is queued, and the new
  // command's first step lands right behind it.
  await null;
  const peer = await jobs.start({ script: "peer", yield_time_ms: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  expect(executed).toEqual(["first"]);
  expect(
    jobs.list().jobs.find((job) => job.job_id === peer.job_id),
  ).toMatchObject({ status: "canceled", cleanup_pending: false });
  await expect(jobs.start({ script: "true" })).rejects.toThrow(
    "cleanup is unconfirmed",
  );
  // The first job's late proof is the only one the fence waits for.
  proveFirst();
  await expect(
    jobs.start({ script: "after proof", yield_time_ms: 0 }),
  ).resolves.toMatchObject({ status: "running" });
  finishFirst({ stdout: "", stderr: "", code: 0, cleanupConfirmed: true });
  await jobs.close();
});
