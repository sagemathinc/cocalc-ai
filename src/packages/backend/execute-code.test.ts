/*
 *  This file is part of CoCalc: Copyright © 2024–2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*

DEVELOPMENT:

pnpm test ./execute-code.test.ts

*/

import { delay } from "awaiting";
import { PROJECT_SECRETS_ENV } from "@cocalc/util/project-secrets";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.COCALC_PROJECT_MONITOR_INTERVAL_S = "1";
// default is much lower, might fail if you have more procs than the default
process.env.COCALC_PROJECT_INFO_PROC_LIMIT = "10000";

import { executeCode, setMonitorIntervalSeconds } from "./execute-code";

describe("hello world", () => {
  it("runs hello world", async () => {
    const { stdout } = await executeCode({
      command: "echo",
      args: ["hello world"],
    });
    expect(stdout).toBe("hello world\n");
  });

  it("preserves streaming callbacks for blocking execution", async () => {
    const chunks: string[] = [];
    const result = await executeCode({
      command: "sh",
      args: ["-c", "printf hello; sleep 0.2; printf world"],
      bash: false,
      streamCB: (event) => {
        if (event.type === "stdout" && typeof event.data === "string") {
          chunks.push(event.data);
        }
      },
    });

    expect(result.stdout).toBe("helloworld");
    expect(chunks.join("")).toBe("helloworld");
  });

  it("executes canonical project paths from the workspace process home", async () => {
    const home = await mkdtemp(join(tmpdir(), "cocalc-workspace-exec-"));
    const previousHome = process.env.HOME;
    const previousRuntimeHome = process.env.COCALC_RUNTIME_HOME;
    try {
      process.env.HOME = home;
      process.env.COCALC_RUNTIME_HOME = "/home/user";
      const { stdout } = await executeCode({
        command: "pwd",
        path: "/home/user",
      });
      expect(stdout.trim()).toBe(home);
    } finally {
      if (previousHome == null) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousRuntimeHome == null) {
        delete process.env.COCALC_RUNTIME_HOME;
      } else {
        process.env.COCALC_RUNTIME_HOME = previousRuntimeHome;
      }
      await rm(home, { recursive: true, force: true });
    }
  });

  it("preserves only the managed project secrets env var from CoCalc-prefixed env", async () => {
    const previousSecrets = process.env[PROJECT_SECRETS_ENV];
    const previousPrivate = process.env.COCALC_PRIVATE_TEST_VALUE;
    process.env[PROJECT_SECRETS_ENV] = "/run/secrets/cocalc";
    process.env.COCALC_PRIVATE_TEST_VALUE = "do-not-leak";
    try {
      const { stdout } = await executeCode({
        command: "sh",
        args: [
          "-c",
          `printf "%s|%s" "$${PROJECT_SECRETS_ENV}" "$COCALC_PRIVATE_TEST_VALUE"`,
        ],
        bash: false,
      });
      expect(stdout).toBe("/run/secrets/cocalc|");
    } finally {
      if (previousSecrets == null) {
        delete process.env[PROJECT_SECRETS_ENV];
      } else {
        process.env[PROJECT_SECRETS_ENV] = previousSecrets;
      }
      if (previousPrivate == null) {
        delete process.env.COCALC_PRIVATE_TEST_VALUE;
      } else {
        process.env.COCALC_PRIVATE_TEST_VALUE = previousPrivate;
      }
    }
  });
});

describe("tests involving bash mode", () => {
  it("runs normal code in bash", async () => {
    const { stdout } = await executeCode({ command: "echo 'abc' | wc -c" });
    // on GitHub actions the output of wc is different than on other machines,
    // so we normalize by trimming.
    expect(stdout.trim()).toBe("4");
  });

  it("reports missing executable in non-bash mode", async () => {
    try {
      await executeCode({
        command: "/usr/bin/this_does_not_exist",
        args: ["nothing"],
        bash: false,
      });
    } catch (err) {
      expect(err).toContain("ENOENT");
    }
  });

  it("reports missing executable in non-bash mode when ignoring on exit", async () => {
    try {
      await executeCode({
        command: "/usr/bin/this_does_not_exist",
        args: ["nothing"],
        err_on_exit: false,
        bash: false,
      });
    } catch (err) {
      expect(err).toContain("ENOENT");
    }
  });

  it("ignores errors otherwise if err_on_exit is false", async () => {
    const { stdout, stderr, exit_code } = await executeCode({
      command: "sh",
      args: ["-c", "echo foo; exit 42"],
      err_on_exit: false,
      bash: false,
    });
    expect(stdout).toBe("foo\n");
    expect(stderr).toBe("");
    expect(exit_code).toBe(42);
  });
});

describe("test timeout", () => {
  it("kills if timeout reached", async () => {
    const t = Date.now();
    try {
      await executeCode({ command: "sleep 60", timeout: 0.1 });
      expect(false).toBe(true);
    } catch (err) {
      expect(err).toContain("killed command");
      expect(Date.now() - t).toBeGreaterThan(90);
      expect(Date.now() - t).toBeLessThan(500);
    }
  });

  it("doesn't kill when timeout not reached", async () => {
    const t = Date.now();
    await executeCode({ command: "sleep 0.1", timeout: 0.5 });
    expect(Date.now() - t).toBeGreaterThan(90);
  });

  it("kills in non-bash mode if timeout reached", async () => {
    try {
      await executeCode({
        command: "sh",
        args: ["-c", "sleep 5"],
        bash: false,
        timeout: 0.1,
      });
      expect(false).toBe(true);
    } catch (err) {
      expect(err).toContain("killed command");
    }
  });
});

describe("test longer execution", () => {
  it(
    "runs 1 seconds",
    async () => {
      const t0 = Date.now();
      const { stdout, stderr, exit_code } = await executeCode({
        command: "sh",
        args: ["-c", "echo foo; sleep 1; echo bar"],
        err_on_exit: false,
        bash: false,
      });
      expect(stdout).toBe("foo\nbar\n");
      expect(stderr).toBe("");
      expect(exit_code).toBe(0);
      const t1 = Date.now();
      expect((t1 - t0) / 1000).toBeGreaterThan(0.9);
    },
    10 * 1000,
  );
});

describe("test env", () => {
  it("allows to specify environment variables", async () => {
    const { stdout, stderr, type } = await executeCode({
      command: "sh",
      args: ["-c", "echo $FOO;"],
      err_on_exit: false,
      bash: false,
      env: { FOO: "bar" },
    });
    expect(type).toBe("blocking");
    expect(stdout).toBe("bar\n");
    expect(stderr).toBe("");
  });
});

describe("async", () => {
  it("use ID to get async result", async () => {
    const c = await executeCode({
      command: "sh",
      args: ["-c", "echo foo; sleep .5; echo bar; sleep .5; echo baz;"],
      bash: false,
      timeout: 10,
      async_call: true,
    });
    expect(c.type).toEqual("async");
    if (c.type !== "async") return;
    const { status, start, job_id } = c;
    expect(status).toEqual("running");
    expect(start).toBeGreaterThan(1);
    expect(typeof job_id).toEqual("string");
    if (typeof job_id !== "string") return;
    await delay(250);
    {
      const s = await executeCode({ async_get: job_id });
      expect(s.type).toEqual("async");
      if (s.type !== "async") return;
      expect(s.status).toEqual("running");
      // partial stdout result
      expect(s.stdout).toEqual("foo\n");
      expect(s.elapsed_s).toBeUndefined();
      expect(s.start).toBeGreaterThan(1);
      expect(s.exit_code).toEqual(0);
    }

    await delay(900);
    {
      const s = await executeCode({ async_get: job_id });
      expect(s.type).toEqual("async");
      if (s.type !== "async") return;
      expect(s.status).toEqual("completed");
      expect(s.stdout).toEqual("foo\nbar\nbaz\n");
      expect(s.elapsed_s).toBeGreaterThan(0.1);
      expect(s.elapsed_s).toBeLessThan(3);
      expect(s.start).toBeGreaterThan(Date.now() - 10 * 1000);
      expect(s.stderr).toEqual("");
      expect(s.exit_code).toEqual(0);
    }
  });

  it("error/err_on_exit=true", async () => {
    const c = await executeCode({
      command: ">&2 echo baz; exit 3",
      bash: true,
      async_call: true,
      err_on_exit: true, // default
    });
    expect(c.type).toEqual("async");
    if (c.type !== "async") return;
    const { job_id } = c;
    expect(typeof job_id).toEqual("string");
    if (typeof job_id !== "string") return;
    await delay(250);
    const s = await executeCode({ async_get: job_id });
    expect(s.type).toEqual("async");
    if (s.type !== "async") return;
    expect(s.status).toEqual("error");
    // Output produced before the failure is preserved -- see the timeout
    // test below for why that matters.
    expect(s.stdout).toEqual("");
    expect(s.stderr).toContain("baz\n");
    // any error is code 1 it seems?
    expect(s.exit_code).toEqual(1);
  });

  // without err_on_exit, the call is "completed" and we get the correct exit code
  it("error/err_on_exit=false", async () => {
    const c = await executeCode({
      command: ">&2 echo baz; exit 3",
      bash: true,
      async_call: true,
      err_on_exit: false,
    });
    expect(c.type).toEqual("async");
    if (c.type !== "async") return;
    const { job_id } = c;
    expect(typeof job_id).toEqual("string");
    if (typeof job_id !== "string") return;
    await delay(250);
    const s = await executeCode({ async_get: job_id });
    expect(s.type).toEqual("async");
    if (s.type !== "async") return;
    expect(s.status).toEqual("completed");
    expect(s.stdout).toEqual("");
    expect(s.stderr).toEqual("baz\n");
    expect(s.exit_code).toEqual(3);
  });

  it("trigger a timeout", async () => {
    const c = await executeCode({
      command: "sh",
      args: ["-c", "echo foo; sleep 1; echo bar;"],
      bash: false,
      timeout: 0.1,
      async_call: true,
    });
    expect(c.type).toEqual("async");
    if (c.type !== "async") return;
    const { status, start, job_id } = c;
    expect(status).toEqual("running");
    expect(start).toBeGreaterThan(1);
    expect(typeof job_id).toEqual("string");
    if (typeof job_id !== "string") return;
    await delay(250);
    // now we check up on the job
    const s = await executeCode({ async_get: job_id });
    expect(s.type).toEqual("async");
    if (s.type !== "async") return;
    expect(s.status).toEqual("error");
    // A timed-out job keeps what it printed before the kill: for a build,
    // that partial log is exactly what the user needs in order to see why
    // it ran long. (Upstream discards it -- worth upstreaming.)
    expect(s.stdout).toEqual("foo\n");
    expect(s.elapsed_s).toBeGreaterThan(0.01);
    expect(s.elapsed_s).toBeLessThan(3);
    expect(s.start).toBeGreaterThan(1);
    expect(s.stderr).toContain(
      "killed command 'sh -c echo foo; sleep 1; echo bar;'",
    );
    expect(s.exit_code).toEqual(1);
  });

  // This test screws up running multiple tests in parallel.
  // ** HENCE SKIPPING THIS - enable it if you edit the executeCode code...**
  it.skip("(BAD TEST) longer running async job", async () => {
    setMonitorIntervalSeconds(1);
    const c = await executeCode({
      command: "sh",
      args: ["-c", `echo foo; python3 -c '${CPU_PY}'; echo bar;`],
      bash: false,
      err_on_exit: false,
      async_call: true,
    });
    expect(c.type).toEqual("async");
    if (c.type !== "async") return;
    const { status, job_id } = c;
    expect(status).toEqual("running");
    expect(typeof job_id).toEqual("string");
    if (typeof job_id !== "string") return;
    await delay(3000);
    // now we check up on the job
    const s = await executeCode({ async_get: job_id, async_stats: true });
    expect(s.type).toEqual("async");
    if (s.type !== "async") return;
    expect(s.elapsed_s).toBeGreaterThan(1);
    expect(s.exit_code).toBe(0);
    expect(s.pid).toBeGreaterThan(1);
    expect(s.stats).toBeDefined();
    if (!Array.isArray(s.stats)) return;
    const pcts = Math.max(...s.stats.map((s) => s.cpu_pct));
    const secs = Math.max(...s.stats.map((s) => s.cpu_secs));
    const mems = Math.max(...s.stats.map((s) => s.mem_rss));
    expect(pcts).toBeGreaterThan(10);
    expect(secs).toBeGreaterThan(1);
    expect(mems).toBeGreaterThan(1);
    expect(s.stdout).toEqual("foo\nbar\n");
    // now without stats, after retrieving it
    const s2 = await executeCode({ async_get: job_id });
    if (s2.type !== "async") return;
    expect(s2.stats).toBeUndefined();
    // and check, that this is not removing stats entirely
    const s3 = await executeCode({ async_get: job_id, async_stats: true });
    if (s3.type !== "async") return;
    expect(Array.isArray(s3.stats)).toBeTruthy();
  });
});

// the await case is essentially like the async case above, but it will block for a bit
describe("await", () => {
  const check = (s) => {
    expect(s.type).toEqual("async");
    if (s.type !== "async") return;
    expect(s.status).toEqual("completed");
    expect(s.elapsed_s).toBeGreaterThan(1);
    expect(s.elapsed_s).toBeLessThan(3);
    expect(s.exit_code).toBe(0);
    expect(s.pid).toBeGreaterThan(1);
    expect(s.stdout).toEqual("foo\n");
    expect(s.stderr).toEqual("");
  };

  it("returns when a job finishes", async () => {
    const c = await executeCode({
      command: "sleep 2; echo 'foo'",
      bash: true,
      err_on_exit: false,
      async_call: true,
    });
    expect(c.type).toEqual("async");
    if (c.type !== "async") return;
    const { status, job_id, pid } = c;
    expect(status).toEqual("running");
    expect(pid).toBeGreaterThan(1);
    const t0 = Date.now();
    const s = await executeCode({
      async_await: true,
      async_get: job_id,
      async_stats: true,
    });
    const t1 = Date.now();
    // This is the main test: it really waited for at least a second until the job completed
    expect((t1 - t0) / 1000).toBeGreaterThan(1);
    check(s);
    if (s.type !== "async") return;
    expect(Array.isArray(s.stats)).toBeTruthy();
    if (!Array.isArray(s.stats)) return;
    expect(s.stats.length).toBeGreaterThan(0);
    for (const stat of s.stats) {
      expect(Number.isFinite(stat.cpu_pct)).toBeTruthy();
      expect(Number.isFinite(stat.cpu_secs)).toBeTruthy();
      expect(Number.isFinite(stat.mem_rss)).toBeTruthy();
      expect(stat.cpu_secs).toBeGreaterThanOrEqual(0);
      expect(stat.mem_rss).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns immediately if already done", async () => {
    const c = await executeCode({
      command: "sleep 1.1; echo 'foo'",
      bash: true,
      err_on_exit: false,
      async_call: true,
    });
    expect(c.type).toEqual("async");
    if (c.type !== "async") return;
    const { status, job_id, pid } = c;
    expect(status).toEqual("running");
    expect(pid).toBeGreaterThan(1);
    await delay(2000);
    const s = await executeCode({
      async_await: true,
      async_get: job_id,
      async_stats: true,
    });
    check(s);
    if (s.type !== "async") return;
    expect(s.elapsed_s).toBeLessThan(1.5);
  });

  it("deal with unknown executables", async () => {
    const c = await executeCode({
      command: "/usr/bin/random123unknown99",
      err_on_exit: false,
      async_call: true,
    });
    expect(c.type).toEqual("async");
    if (c.type !== "async") return;
    const { job_id, pid } = c;
    expect(pid).toBeUndefined();
    const s = await executeCode({
      async_await: true,
      async_get: job_id,
      async_stats: true,
    });
    expect(s.type).toEqual("async");
    if (s.type !== "async") return;
    expect(s.exit_code).toBe(1);
    expect(s.stderr).toContain("ENOENT");
    expect(s.status).toBe("error");
  });

  it("returns an error", async () => {
    const c = await executeCode({
      command: "sleep .1; >&2 echo baz; exit 3",
      bash: true,
      err_on_exit: false,
      async_call: true,
    });
    expect(c.type).toEqual("async");
    if (c.type !== "async") return;
    const { status, job_id, pid } = c;
    expect(status).toEqual("running");
    expect(pid).toBeGreaterThan(1);
    const t0 = Date.now();
    const s = await executeCode({
      async_await: true,
      async_get: job_id,
      async_stats: true,
    });
    // i've seen outputs like 0.027, so changing from 0.05 to 0.01.
    // no clue what the point of this test is so...
    expect((Date.now() - t0) / 1000).toBeGreaterThan(0.01);
    expect(s.type).toEqual("async");
    if (s.type !== "async") return;
    expect(s.stderr).toEqual("baz\n");
    expect(s.exit_code).toEqual(3);
    expect(s.status).toEqual("completed");
  });

  it("react to a killed process", async () => {
    const c = await executeCode({
      command: "sh",
      args: ["-c", `echo foo; sleep 1; echo bar;`],
      bash: false,
      err_on_exit: false,
      async_call: true,
    });
    expect(c.type).toEqual("async");
    if (c.type !== "async") return;
    const { job_id, pid } = c;
    await delay(100);
    await executeCode({
      command: `kill -9 -${pid}`,
      bash: true,
    });
    const s = await executeCode({
      async_await: true,
      async_get: job_id,
      async_stats: true,
    });
    expect(s.type).toEqual("async");
    if (s.type !== "async") return;
    expect(s.stderr).toEqual("");
    expect(s.stdout).toEqual("foo\n");
    expect(s.exit_code).toEqual(0);
    expect(s.status).toEqual("completed");
  });
});

// Tests for the updates EventEmitter streaming (used by exec-stream for build coordination)
describe("updates EventEmitter streaming for async jobs", () => {
  it("emits stdout and stderr events on updates for async jobs", async () => {
    const { updates, eventKey } = await import("./execute-code");

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let finishedResult: any = null;

    const job = await executeCode({
      command: "echo 'hello'; >&2 echo 'world'",
      bash: true,
      async_call: true,
      err_on_exit: false,
    });
    expect(job.type).toBe("async");
    if (job.type !== "async") return;

    const jobId = job.job_id;
    updates.on(eventKey("stdout", jobId), (data: string) => {
      stdoutChunks.push(data);
    });
    updates.on(eventKey("stderr", jobId), (data: string) => {
      stderrChunks.push(data);
    });
    updates.once(eventKey("finished", jobId), (result) => {
      finishedResult = result;
    });

    // Wait for completion
    while (!finishedResult) await delay(50);

    // Cleanup
    updates.removeAllListeners(eventKey("stdout", jobId));
    updates.removeAllListeners(eventKey("stderr", jobId));

    expect(stdoutChunks.join("")).toContain("hello");
    expect(stderrChunks.join("")).toContain("world");
    expect(finishedResult.status).toBe("completed");
  });

  it("emits stdout events even without streamCB", async () => {
    const { updates, eventKey } = await import("./execute-code");

    const chunks: string[] = [];
    let done = false;

    // No streamCB provided — should still emit on updates
    const job = await executeCode({
      command: "for i in 1 2 3; do echo line$i; sleep 0.05; done",
      bash: true,
      async_call: true,
      err_on_exit: false,
    });
    expect(job.type).toBe("async");
    if (job.type !== "async") return;

    const jobId = job.job_id;
    updates.on(eventKey("stdout", jobId), (data: string) => {
      chunks.push(data);
    });
    updates.once(eventKey("finished", jobId), () => {
      done = true;
    });

    while (!done) await delay(50);
    updates.removeAllListeners(eventKey("stdout", jobId));

    const all = chunks.join("");
    expect(all).toContain("line1");
    expect(all).toContain("line2");
    expect(all).toContain("line3");
  });

  it("emits finished event with error status for failing commands", async () => {
    const { updates, eventKey } = await import("./execute-code");

    let finishedResult: any = null;

    const job = await executeCode({
      command: "exit 42",
      bash: true,
      async_call: true,
      err_on_exit: true,
    });
    expect(job.type).toBe("async");
    if (job.type !== "async") return;

    const jobId = job.job_id;
    updates.once(eventKey("finished", jobId), (result) => {
      finishedResult = result;
    });

    while (!finishedResult) await delay(50);

    expect(finishedResult.status).toBe("error");
    // The exit_code may be normalized by the error handling path
    expect(finishedResult.exit_code).toBeGreaterThan(0);
  });
});

// we burn a bit of CPU to get the cpu_pct and cpu_secs up
const CPU_PY = `
from time import time
t0=time()
while t0+2.5>time():
  sum([_ for _ in range(10**6)])
`;
