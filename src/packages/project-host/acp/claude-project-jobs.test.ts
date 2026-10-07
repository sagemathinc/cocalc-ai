import {
  ClaudeProjectJobs,
  type ProjectJobExecutor,
} from "./claude-project-jobs";
import type { SandboxExecResult } from "@cocalc/project-runner/run/sandbox-exec";

function fixture() {
  const runs: {
    signal: AbortSignal;
    output: Parameters<ProjectJobExecutor>[3]["onOutput"];
    finish: (result: SandboxExecResult) => void;
    confirmCleanup: () => void;
  }[] = [];
  const execute: ProjectJobExecutor = jest.fn(
    async (_script, _cwd, signal, { onOutput, onCleanupConfirmed }) =>
      new Promise((resolve) => {
        runs.push({
          signal,
          output: onOutput,
          confirmCleanup: onCleanupConfirmed,
          finish: (result) => resolve({ cleanupConfirmed: true, ...result }),
        });
        signal.addEventListener(
          "abort",
          () =>
            resolve({
              code: 130,
              stdout: "",
              stderr: "",
              cleanupConfirmed: true,
            }),
          { once: true },
        );
      }),
  );
  return { jobs: new ClaudeProjectJobs(execute), execute, runs };
}

test("yielding does not stop jobs; cursors replay output and preserve a nonzero exit", async () => {
  const { jobs, runs } = fixture();
  try {
    const first = await jobs.start({ script: "build", yield_time_ms: 0 });
    expect(first.status).toBe("running");
    expect(first.code).toBeNull();
    expect(runs[0].signal.aborted).toBe(false);
    runs[0].output("stdout", "building\n");
    const next = await jobs.wait({
      job_id: first.job_id,
      cursor: first.next_cursor,
      yield_time_ms: 0,
    });
    expect(next.stdout).toBe("building\n");
    expect(
      (await jobs.wait({ job_id: first.job_id, cursor: 0, yield_time_ms: 0 }))
        .stdout,
    ).toBe(next.stdout);
    expect(
      (
        await jobs.wait({
          job_id: first.job_id,
          cursor: next.next_cursor,
          yield_time_ms: 0,
        })
      ).stdout,
    ).toBe("");
    runs[0].output("stderr", "failed\n");
    runs[0].finish({ code: 7, stdout: "", stderr: "" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      await jobs.wait({ job_id: first.job_id, cursor: next.next_cursor }),
    ).toMatchObject({
      status: "failed",
      code: 7,
      stdout: "",
      stderr: "failed\n",
    });
  } finally {
    await jobs.close();
  }
});

test("retry IDs and list recover uncertain starts without re-execution", async () => {
  const { jobs, execute } = fixture();
  try {
    const args = { script: "build", request_id: "retry-1", yield_time_ms: 0 };
    const first = await jobs.start(args);
    expect((await jobs.start(args)).job_id).toBe(first.job_id);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(jobs.list().jobs[0]).toMatchObject({
      job_id: first.job_id,
      request_id: "retry-1",
      status: "running",
    });
    await expect(jobs.start({ ...args, script: "different" })).rejects.toThrow(
      "different command",
    );
    expect((await jobs.cancel({ job_id: first.job_id })).status).toBe(
      "canceled",
    );
    expect((await jobs.cancel({ job_id: first.job_id })).cleanup_pending).toBe(
      false,
    );
    expect((await jobs.start(args)).status).toBe("canceled");
    expect(execute).toHaveBeenCalledTimes(1);
  } finally {
    await jobs.close();
  }
});

test("output is paginated and bounded, with explicit loss and no command termination", async () => {
  const { jobs, runs } = fixture();
  try {
    const job = await jobs.start({ script: "verbose", yield_time_ms: 0 });
    const unicode = "a".repeat(4095) + "\u{1F600}";
    runs[0].output("stdout", unicode);
    expect(
      (await jobs.wait({ job_id: job.job_id, yield_time_ms: 0 })).stdout,
    ).toBe(unicode);
    runs[0].output("stdout", "z".repeat(2 * 1024 * 1024));
    const page = await jobs.wait({ job_id: job.job_id, yield_time_ms: 0 });
    expect(page.output_truncated).toBe(true);
    expect(page.has_more).toBe(true);
    expect(Buffer.byteLength(page.stdout)).toBeLessThanOrEqual(64 * 1024);
    expect(page.status).toBe("running");
    expect(runs[0].signal.aborted).toBe(false);
  } finally {
    await jobs.close();
  }
});

test("deadlines cancel execution, independently of tool wait time", async () => {
  jest.useFakeTimers();
  const { jobs, runs } = fixture();
  try {
    const job = await jobs.start({
      script: "long",
      timeout_ms: 10000,
      yield_time_ms: 0,
    });
    await jest.advanceTimersByTimeAsync(9999);
    expect(runs[0].signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(runs[0].signal.aborted).toBe(true);
    expect(
      await jobs.wait({ job_id: job.job_id, yield_time_ms: 0 }),
    ).toMatchObject({ status: "timed_out", cleanup_pending: false });
    await jest.advanceTimersByTimeAsync(600001);
    await expect(jobs.wait({ job_id: job.job_id })).rejects.toThrow("expired");
  } finally {
    await jobs.close();
    jest.useRealTimers();
  }
});

test("concurrency, input validation, ownership and controller cancellation fail closed", async () => {
  const { jobs, runs } = fixture();
  const other = fixture();
  try {
    for (let i = 0; i < 4; i++)
      await jobs.start({ script: "long", yield_time_ms: 0 });
    await expect(jobs.start({ script: "extra" })).rejects.toThrow("Four");
    await expect(
      jobs.start({ script: "long", timeout_ms: Infinity }),
    ).rejects.toThrow("integer");
    await expect(
      jobs.wait({ job_id: jobs.list().jobs[0].job_id, cursor: 1 }),
    ).rejects.toThrow("ahead");
    await expect(
      other.jobs.cancel({ job_id: jobs.list().jobs[0].job_id }),
    ).rejects.toThrow("Unknown");
    await jobs.cancelAll();
    expect(runs.every((run) => run.signal.aborted)).toBe(true);
    await expect(jobs.start({ script: "blocked" })).rejects.toThrow("closed");
    jobs.resume();
    await jobs.start({ script: "next turn", yield_time_ms: 0 });
    await jobs.close();
    jobs.resume();
    await expect(jobs.start({ script: "closed" })).rejects.toThrow("closed");
  } finally {
    await jobs.close();
    await other.jobs.close();
  }
});

test("waiting is awakened by completion with no output", async () => {
  const { jobs, runs } = fixture();
  try {
    const job = await jobs.start({ script: "quiet", yield_time_ms: 0 });
    const waiting = jobs.wait({ job_id: job.job_id, yield_time_ms: 30000 });
    runs[0].finish({ code: 0, stdout: "", stderr: "" });
    expect(await waiting).toMatchObject({
      status: "completed",
      code: 0,
      has_more: false,
    });
  } finally {
    await jobs.close();
  }
});

test("wait batches intermittent output until its interval expires", async () => {
  jest.useFakeTimers();
  const { jobs, runs } = fixture();
  try {
    const job = await jobs.start({ script: "ticks", yield_time_ms: 0 });
    runs[0].output("stdout", "already buffered\n");
    let returned = false;
    const waiting = jobs
      .wait({ job_id: job.job_id, yield_time_ms: 30000 })
      .then((value) => {
        returned = true;
        return value;
      });
    for (let i = 0; i < 3; i++) {
      await jest.advanceTimersByTimeAsync(9999);
      runs[0].output("stdout", `tick ${i}\n`);
      await Promise.resolve();
      expect(returned).toBe(false);
    }
    await jest.advanceTimersByTimeAsync(3);
    expect((await waiting).stdout).toBe(
      "already buffered\ntick 0\ntick 1\ntick 2\n",
    );
  } finally {
    await jobs.close();
    jest.useRealTimers();
  }
});

test("waits accept up to two minutes and end early when guidance arrives", async () => {
  const { jobs, runs } = fixture();
  try {
    const job = await jobs.start({ script: "build", yield_time_ms: 0 });
    await expect(
      jobs.wait({ job_id: job.job_id, yield_time_ms: 120_001 }),
    ).rejects.toThrow("between 0 and 120000");
    runs[0].output("stdout", "compiling\n");
    const waiting = jobs.wait({ job_id: job.job_id, yield_time_ms: 120_000 });
    jobs.releaseWaits();
    expect(await waiting).toMatchObject({
      status: "running",
      stdout: "compiling\n",
    });
    expect(runs[0].signal.aborted).toBe(false);
    // A release ends only the waits pending at that moment.
    let returned = false;
    const later = jobs
      .wait({ job_id: job.job_id, cursor: 1, yield_time_ms: 120_000 })
      .then(() => (returned = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(returned).toBe(false);
    runs[0].finish({ code: 0, stdout: "", stderr: "" });
    await later;
  } finally {
    await jobs.close();
  }
});

test("a full output page ends a wait early without restarting the command", async () => {
  const { jobs, runs } = fixture();
  try {
    const job = await jobs.start({ script: "output", yield_time_ms: 0 });
    const waiting = jobs.wait({ job_id: job.job_id, yield_time_ms: 30000 });
    runs[0].output("stdout", "x".repeat(65536));
    expect((await waiting).stdout).toHaveLength(65536);
    expect(runs[0].signal.aborted).toBe(false);
  } finally {
    await jobs.close();
  }
});

test("initial wait defaults to ten seconds, independently of the deadline", async () => {
  jest.useFakeTimers();
  const { jobs } = fixture();
  try {
    let returned = false;
    const waiting = jobs.start({ script: "build" }).then((value) => {
      returned = true;
      return value;
    });
    await jest.advanceTimersByTimeAsync(9999);
    expect(returned).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect((await waiting).status).toBe("running");
  } finally {
    await jobs.close();
    jest.useRealTimers();
  }
});

test("evicted output never turns a retry ID into a duplicate execution", async () => {
  const execute = jest.fn(async () => ({
    code: 0,
    stdout: "",
    stderr: "",
    cleanupConfirmed: true,
  }));
  const jobs = new ClaudeProjectJobs(execute);
  try {
    await jobs.start({ script: "first", request_id: "once" });
    for (let i = 0; i < 33; i++) await jobs.start({ script: `command-${i}` });
    await expect(
      jobs.start({ script: "first", request_id: "once" }),
    ).rejects.toThrow("expired");
    expect(execute).toHaveBeenCalledTimes(34);
  } finally {
    await jobs.close();
  }
});

test("unconfirmed cleanup stays pending, blocks admission and survives resume", async () => {
  const { jobs, runs } = fixture();
  const first = await jobs.start({ script: "unconfirmed", yield_time_ms: 0 });
  const other = await jobs.start({ script: "other", yield_time_ms: 0 });
  runs[0].finish({
    code: null,
    stdout: "",
    stderr: "cleanup failed",
    cleanupConfirmed: false,
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(runs[1].signal.aborted).toBe(true);
  expect(await jobs.cancel({ job_id: first.job_id })).toMatchObject({
    status: "failed",
    cleanup_pending: true,
    cleanup_error: "Runtime could not verify job cleanup",
    finished_at: undefined,
  });
  expect(
    jobs.list().jobs.find((job) => job.job_id === first.job_id),
  ).toMatchObject({ cleanup_pending: true });
  expect(
    await jobs.wait({ job_id: other.job_id, yield_time_ms: 0 }),
  ).toMatchObject({ status: "canceled" });
  jobs.resume();
  await expect(jobs.start({ script: "must not run" })).rejects.toThrow(
    "cleanup is unconfirmed",
  );
  await jobs.close();
  runs[0].confirmCleanup();
});

test("an executor rejection is not evidence that its processes were cleaned up", async () => {
  let confirmCleanup: () => void;
  const jobs = new ClaudeProjectJobs(
    async (_script, _cwd, _signal, options) => {
      confirmCleanup = options.onCleanupConfirmed;
      throw Error("lost transport");
    },
  );
  const job = await jobs.start({ script: "start" });
  expect(job.cleanup_pending).toBe(true);
  expect(job.status).toBe("failed");
  await expect(jobs.start({ script: "again" })).rejects.toThrow(
    "cleanup is unconfirmed",
  );
  await jobs.close();
  confirmCleanup!();
});

test("confirmed recovery releases capacity without reopening a fenced controller", async () => {
  const { jobs, runs } = fixture();
  const first = await jobs.start({
    script: "lost transport",
    yield_time_ms: 0,
  });
  runs[0].finish({
    code: null,
    stdout: "",
    stderr: "",
    cleanupConfirmed: false,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await jobs.cancel({ job_id: first.job_id });
  runs[0].confirmCleanup();
  expect(
    await jobs.wait({ job_id: first.job_id, yield_time_ms: 0 }),
  ).toMatchObject({
    status: "failed",
    cleanup_pending: false,
    cleanup_error: undefined,
    finished_at: expect.any(Number),
  });
  jobs.resume();
  await expect(jobs.start({ script: "still fenced" })).rejects.toThrow(
    "cleanup is unconfirmed",
  );
  await jobs.close();
});

test("recovery proof racing executor completion cannot release a running reservation", async () => {
  const { jobs, runs } = fixture();
  const first = await jobs.start({ script: "finishing", yield_time_ms: 0 });
  runs[0].confirmCleanup();
  expect(jobs.list().jobs[0].finished_at).toBeUndefined();
  runs[0].finish({
    code: null,
    stdout: "",
    stderr: "",
    cleanupConfirmed: false,
  });
  await jobs.cancel({ job_id: first.job_id });
  expect(jobs.list().jobs[0].cleanup_pending).toBe(false);
  await jobs.close();
});

test("duplicate recovery after close releases a reservation exactly once", async () => {
  const abandoned = fixture();
  const active = Array.from({ length: 16 }, () => fixture());
  try {
    const first = await abandoned.jobs.start({
      script: "uncertain",
      yield_time_ms: 0,
    });
    abandoned.runs[0].finish({
      code: null,
      stdout: "",
      stderr: "",
      cleanupConfirmed: false,
    });
    await abandoned.jobs.cancel({ job_id: first.job_id });
    await abandoned.jobs.close();
    abandoned.runs[0].confirmCleanup();
    for (const { jobs } of active)
      for (let i = 0; i < 4; i++)
        await jobs.start({ script: "running", yield_time_ms: 0 });
    abandoned.runs[0].confirmCleanup();
    const extra = fixture();
    try {
      await expect(
        extra.jobs.start({ script: "over capacity", yield_time_ms: 0 }),
      ).rejects.toThrow("capacity reached");
    } finally {
      await extra.jobs.close();
    }
  } finally {
    for (const { jobs } of active) await jobs.close();
    await abandoned.jobs.close();
    abandoned.runs[0]?.confirmCleanup();
  }
});

test("cancel reports the outcome instead of replaying old output", async () => {
  const { jobs, runs } = fixture();
  try {
    const first = await jobs.start({ script: "grep", yield_time_ms: 0 });
    runs[0].output("stdout", "x".repeat(50_000));
    const canceled = await jobs.cancel({ job_id: first.job_id });
    expect(canceled).toMatchObject({
      status: "canceled",
      stdout: "",
      has_more: false,
    });
    // The output is still there for a caller that asks for it.
    const replay = await jobs.wait({
      job_id: first.job_id,
      cursor: 0,
      yield_time_ms: 0,
    });
    expect(replay.stdout.length).toBe(50_000);
  } finally {
    await jobs.close();
  }
});

test("unconfirmed cleanup says who can recover and how", async () => {
  const execute = jest.fn(async () => ({
    code: 1,
    stdout: "",
    stderr: "",
    cleanupConfirmed: false,
  }));
  const jobs = new ClaudeProjectJobs(execute as any);
  try {
    await jobs.start({ script: "grep", yield_time_ms: 1000 });
    await expect(jobs.start({ script: "echo alive" })).rejects.toThrow(
      /Only the user can recover: ask them to restart the project/,
    );
  } finally {
    await jobs.close();
  }
});
