/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { runContainedSandboxCommand } from "@cocalc/project-runner/run/sandbox-command-containment";
import { ClaudeProjectJobs } from "./claude-project-jobs";

const mockSpawn = jest.fn();
const mockExecFile = jest.fn();
jest.mock("node:child_process", () => ({
  spawn: (...args) => mockSpawn(...args),
  execFile: (...args) => mockExecFile(...args),
}));
jest.mock("@cocalc/backend/podman/env", () => ({
  podmanEnv: () => ({ PATH: "/usr/bin" }),
}));

test("64 abandoned bridges recover only exact confirmed reservations after close", async () => {
  jest.useFakeTimers();
  const children: any[] = [];
  const queries: { project_id: string; scope: string }[] = [];
  const controllers: ClaudeProjectJobs[] = [];
  const confirmed = new Set<string>();
  mockSpawn.mockImplementation((_cmd, args) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: jest.fn(),
    });
    const scope = `job-${process.pid}-1-42-2-999999999999-${args[4]}`;
    queries.push({ project_id: args[3], scope });
    children.push(child);
    return child;
  });
  mockExecFile.mockImplementation((_cmd, args, _options, callback) => {
    expect(args).toContain("confirm-project-job-cleanup");
    const stdin = new PassThrough();
    stdin.on("data", (data) => {
      const { jobs } = JSON.parse(data.toString());
      expect(jobs).toHaveLength(64);
      callback(
        null,
        JSON.stringify({
          confirmed: jobs.filter((job) => confirmed.has(job.scope)),
        }),
      );
    });
    return { stdin };
  });
  const controller = (id: number) => {
    const project_id = `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`;
    const jobs = new ClaudeProjectJobs((_script, _cwd, signal, options) =>
      runContainedSandboxCommand({
        project_id,
        args: ["exec", "fixture"],
        signal,
        ...options,
      }),
    );
    controllers.push(jobs);
    return jobs;
  };
  try {
    for (let i = 0; i < 64; i++) {
      const jobs = controller(i);
      const first = await jobs.start({ script: "fixture", yield_time_ms: 0 });
      children[i].stdout.write(
        JSON.stringify({ type: "scope", scope: queries[i].scope }) + "\n",
      );
      children[i].emit("close", 1);
      expect(await jobs.cancel({ job_id: first.job_id })).toMatchObject({
        cleanup_pending: true,
      });
      await jobs.close();
      expect(jobs.list().jobs).toEqual([]);
    }
    const healthy = controller(64);
    await expect(healthy.start({ script: "healthy" })).rejects.toThrow(
      "capacity reached",
    );
    // Helper success with no exact proofs must not release even one slot.
    await jest.advanceTimersByTimeAsync(30_000);
    await expect(healthy.start({ script: "healthy" })).rejects.toThrow(
      "capacity reached",
    );
    confirmed.add(queries[0].scope);
    await jest.advanceTimersByTimeAsync(30_000);
    const admitted = await healthy.start({
      script: "healthy",
      yield_time_ms: 0,
    });
    expect(admitted.status).toBe("running");
    await expect(
      controller(65).start({ script: "no extra slot" }),
    ).rejects.toThrow("capacity reached");
    // A recovered controller remains permanently closed/fenced.
    controllers[0].resume();
    await expect(
      controllers[0].start({ script: "no reopening" }),
    ).rejects.toThrow("cleanup is unconfirmed");
    controllers[1].resume();
    await expect(
      controllers[1].start({ script: "unresolved" }),
    ).rejects.toThrow("cleanup is unconfirmed");
    children[64].stdout.write('{"type":"exit","code":0,"cleanup":true}\n');
    children[64].emit("close", 0);
    await healthy.close();
  } finally {
    // Drain remaining proofs so timers/capacity cannot bleed into later tests.
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
    for (const jobs of controllers) await jobs.close();
    jest.useRealTimers();
  }
});
