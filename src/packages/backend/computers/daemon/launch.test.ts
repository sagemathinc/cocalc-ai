/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Crash safety of launching commands, and the identity of what we signal.

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Cleanups } from "./cleanups";
import { runExec } from "./exec";
import { JobManager } from "./jobs";
import { leaderAlive, processStartTime } from "./launch";

const DIST = join(__dirname, "../../dist/computers/daemon/jobs.js");

function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (check()) return resolve();
      if (Date.now() - start > ms) return reject(new Error("timed out"));
      setTimeout(poll, 25);
    };
    poll();
  });
}

const groupAlive = (pid: number) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("launching commands", () => {
  let dir: string;
  let work: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "computer-launch-"));
    work = join(dir, "work");
    mkdirSync(work);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const spec = (command: string) => {
    const job_id = randomUUID();
    return {
      job_id,
      operation_id: job_id,
      agent_id: randomUUID(),
      source_project_id: randomUUID(),
      name: null,
      description: "test",
      command,
      cwd: work,
      nice: false,
      exclusive: false,
      auth: {
        computer_epoch: 0,
        policy_epoch: 0,
        privacy_epoch: 0,
        deadline_at: null,
      },
    };
  };
  const ranCount = (marker: string) =>
    existsSync(marker)
      ? readFileSync(marker, "utf8").split("\n").filter(Boolean).length
      : 0;

  async function settle(stateDir: string, job_id: string) {
    const jobs = new JobManager(stateDir, { killGraceMs: 200 });
    await waitFor(() => {
      jobs.refresh();
      const s = jobs.get(job_id)?.state;
      return s != null && s !== "running" && s !== "starting" && s !== "queued";
    });
    return jobs;
  }

  (existsSync(DIST) ? describe : describe.skip)(
    "a daemon killed (SIGKILL) at each launch boundary never runs a job twice",
    () => {
      it.each([
        ["starting", "cancelled", 0],
        ["spawned", "cancelled", 0],
        ["recorded", "lost", 0],
        ["released", "exited", 1],
      ] as const)(
        "killed at %s: the job ends %s and ran %i time(s)",
        async (point, state, runs) => {
          const stateDir = join(dir, "state");
          const marker = join(dir, "marker");
          const s = spec(`echo x >> ${marker}`);
          const script = `
          const { JobManager } = require(${JSON.stringify(DIST)});
          const jobs = new JobManager(${JSON.stringify(stateDir)}, {
            launchHook: (p) => { if (p === ${JSON.stringify(point)}) process.kill(process.pid, "SIGKILL"); },
          });
          jobs.submit(${JSON.stringify(s)});
          setTimeout(() => {}, 1000);`;
          const r = spawnSync(process.execPath, ["-e", script], {
            stdio: "ignore",
          });
          expect(r.signal).toBe("SIGKILL");
          // Give an unreleased wrapper time to see fd 3 close and leave.
          await new Promise((resolve) => setTimeout(resolve, 500));
          const jobs = await settle(stateDir, s.job_id);
          expect(jobs.get(s.job_id)!.state).toBe(state);
          // Another restart never dispatches it again.
          jobs.refresh();
          await new Promise((resolve) => setTimeout(resolve, 300));
          expect(ranCount(marker)).toBe(runs);
        },
      );
    },
  );

  it("a durable write that fails after spawn never releases the job", async () => {
    const stateDir = join(dir, "state");
    const marker = join(dir, "marker");
    const s = spec(`echo x >> ${marker}`);
    const jobs = new JobManager(stateDir, {
      launchHook: (p) => {
        if (p === "spawned") throw new Error("disk full");
      },
    });
    expect(() => jobs.submit(s)).toThrow(/disk full/);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const after = await settle(stateDir, s.job_id);
    expect(after.get(s.job_id)!.state).toBe("cancelled");
    expect(ranCount(marker)).toBe(0);
  });

  it("an exec that can't be recorded is never started", async () => {
    const marker = join(dir, "marker");
    await expect(
      runExec(
        {
          command: `echo x >> ${marker}`,
          cwd: null,
          timeout_ms: 5000,
          stdin: null,
        },
        {
          workdir: work,
          logDir: join(dir, "exec"),
          shell: "/bin/bash",
          onSpawn: () => {
            throw new Error("disk full");
          },
        },
      ),
    ).rejects.toThrow(/was not started/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(ranCount(marker)).toBe(0);
  });

  it("the leader stays while anything of the job is left, so the job isn't over yet", async () => {
    const stateDir = join(dir, "state");
    const jobs = new JobManager(stateDir, { killGraceMs: 200 });
    // The command exits at once, leaving a background process in the group.
    const s = spec("sleep 30 & exit 0");
    jobs.submit(s);
    await new Promise((resolve) => setTimeout(resolve, 500));
    jobs.refresh();
    const job = jobs.get(s.job_id)!;
    expect(job.state).toBe("running");
    expect(leaderAlive(job.pid, job.pid_start)).toBe(true);
    // Killing it reaches the leftover too.
    jobs.kill(s.job_id, s.agent_id);
    await waitFor(() => {
      jobs.refresh();
      return jobs.get(s.job_id)!.state === "killed";
    });
    expect(groupAlive(job.pid!)).toBe(false);
  });

  it("never signals a group whose leader is gone (its id could be reused)", async () => {
    const stateDir = join(dir, "state");
    const jobs = new JobManager(stateDir, { killGraceMs: 100 });
    const s = spec("trap '' TERM; while :; do sleep 0.1; done");
    jobs.submit(s);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const pid = jobs.get(s.job_id)!.pid!;
    // Something else kills only the leader; its TERM-ignoring child lives on.
    process.kill(pid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(groupAlive(pid)).toBe(true);
    jobs.kill(s.job_id, s.agent_id);
    await waitFor(() => {
      jobs.refresh();
      return jobs.get(s.job_id)!.state === "killed";
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    jobs.refresh();
    // Unverifiable, so untouched (direct mode is best effort here).
    expect(groupAlive(pid)).toBe(true);
    process.kill(-pid, "SIGKILL");
  });

  it("cleanup of a process left by a dead daemon is re-driven across restarts until it is gone", async () => {
    const stateDir = join(dir, "state");
    const child = spawn(
      "/bin/sh",
      ["-c", "trap '' TERM; while :; do sleep 0.1; done"],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    child.unref();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const pid = child.pid!;
    const id = randomUUID();
    const first = new Cleanups(stateDir, 600_000);
    first.add(id, pid, processStartTime(pid)!);
    first.drive(); // SIGTERM, ignored
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(groupAlive(pid)).toBe(true);
    // The daemon dies during the grace period; the next one finishes it.
    const second = new Cleanups(stateDir, 100);
    await waitFor(() => {
      second.drive();
      return second.pending().length === 0;
    });
    expect(groupAlive(pid)).toBe(false);
  });

  it("a job whose process identity can't be read is never released", async () => {
    const stateDir = join(dir, "state");
    const marker = join(dir, "marker");
    const s = spec(`echo x >> ${marker}`);
    const jobs = new JobManager(stateDir, { identify: () => undefined });
    expect(() => jobs.submit(s)).toThrow(/could not identify/);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const after = await settle(stateDir, s.job_id);
    expect(after.get(s.job_id)!.state).toBe("cancelled");
    expect(ranCount(marker)).toBe(0);
  });

  it("killing right after release never leaves an unverifiable survivor", async () => {
    const stateDir = join(dir, "state");
    const jobs = new JobManager(stateDir, { killGraceMs: 100 });
    for (let i = 0; i < 8; i++) {
      const s = spec("trap '' TERM; while :; do sleep 0.05; done");
      jobs.submit(s);
      jobs.kill(s.job_id, s.agent_id); // immediately
      const pid = jobs.get(s.job_id)!.pid!;
      await waitFor(() => {
        jobs.refresh();
        return jobs.get(s.job_id)!.state === "killed";
      });
      expect(groupAlive(pid)).toBe(false);
    }
  });
});
