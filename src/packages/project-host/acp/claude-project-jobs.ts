/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { createHash, randomUUID } from "node:crypto";
import getLogger from "@cocalc/backend/logger";
import type { SandboxExecResult } from "@cocalc/project-runner/run/sandbox-exec";

const logger = getLogger("project-host:acp:claude-project-jobs");

export type ProjectJobExecutor = (
  script: string,
  cwd: string | undefined,
  signal: AbortSignal,
  options: {
    timeoutMs: number;
    onOutput: (stream: "stdout" | "stderr", data: string) => void;
    /** Trusted runtime proof, including recovery after the executor settles. */
    onCleanupConfirmed: () => void;
  },
) => Promise<SandboxExecResult>;
type Status = "running" | "completed" | "failed" | "canceled" | "timed_out";
interface Job {
  id: string;
  transient?: boolean;
  requestId?: string;
  fingerprint: string;
  abort: AbortController;
  status: Status;
  code: number | null;
  started: number;
  finished?: number;
  cleanupUnconfirmed?: boolean;
  // The runtime proved this job's processes are gone (possibly late).
  cleanupProven?: boolean;
  deadline: number;
  output: {
    seq: number;
    stream: "stdout" | "stderr";
    data: string;
    bytes: number;
  }[];
  bytes: number;
  next: number;
  changed: Set<() => void>;
  done: Promise<void>;
}
const DEFAULT_TIMEOUT = 3_600_000;
const DEFAULT_WAIT = 10_000;
// Below the bridge's 150 s idle socket timeout. Guidance ends a wait early.
export const MAX_WAIT = 120_000;
const MAX_TIMEOUT = 86_400_000;
const RETENTION = 600_000;
const OUTPUT_BYTES = 1024 * 1024;
// A fence is usually brief (the runtime rechecks 5 s after it and then every
// 30 s), so a new tool call waits this long for it to lift before failing.
function defaultFenceWaitMs(): number {
  const ms = Number(process.env.COCALC_PROJECT_TOOL_FENCE_WAIT_MS ?? 60_000);
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 90_000) : 60_000;
}
// Says what happens next: the runtime keeps checking, and tools reopen on its
// proof. The fence belongs to this agent session (controller): a new session
// starts without it, as does a project restart. Agents must read it as
// temporary, not as a reason to stop.
function cleanupUnconfirmed(jobIds: string[], waitedMs: number): string {
  const jobs = jobIds.length ? ` (job ${jobIds.join(", ")})` : "";
  const waited =
    waitedMs >= 1000
      ? ` This call already waited ${Math.round(waitedMs / 1000)} s.`
      : "";
  return `Project tools are paused for a moment: an earlier command's cleanup is unconfirmed${jobs}, so the runtime has not yet confirmed that its processes are gone. This is temporary: it rechecks automatically about every 30 seconds, and project tools reopen by themselves.${waited} Retry in 30 seconds. If it still fails after a few minutes, tell the user; a new agent session or a project restart also reopens them.`;
}
const PAGE_BYTES = 64 * 1024;
let activeJobs = 0;

function reserve(job: Job) {
  activeJobs++;
  let settled = false;
  let confirmed = false;
  // Keep late recovery independent of the controller and its executor/authority.
  const release = () => {
    if (job.finished !== undefined) return;
    activeJobs--;
    job.cleanupUnconfirmed = false;
    job.finished = Date.now();
    for (const resolve of [...job.changed]) resolve();
  };
  return {
    confirmCleanup: () => {
      confirmed = true;
      if (settled) release();
    },
    settle: () => {
      settled = true;
      if (!job.cleanupUnconfirmed || confirmed) release();
    },
  };
}

function integer(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > max
  )
    throw Error(`Expected an integer between 0 and ${max}`);
  return value as number;
}

/** Private to one controller/binding; IDs from another bridge confer no authority. */
export class ClaudeProjectJobs {
  private jobs = new Map<string, Job>();
  private requests = new Map<string, { fingerprint: string; jobId: string }>();
  private paused = false;
  private closed = false;
  private cleanupBlocked = false;
  // Jobs whose cleanup is unproven; tools reopen once this is empty.
  private unproven = new Set<Job>();
  private waits = new Set<() => void>();
  // Calls waiting for the fence to lift (or for close).
  private reopened = new Set<() => void>();
  private fenceWaitMs: number;
  private reauthorize?: () => Promise<void>;
  constructor(
    private execute: ProjectJobExecutor,
    options: {
      fenceWaitMs?: number;
      // Checked again after waiting out a fence, before any work starts: the
      // caller's authority was checked before the wait and may since be gone.
      reauthorize?: () => Promise<void>;
    } = {},
  ) {
    this.fenceWaitMs = options.fenceWaitMs ?? defaultFenceWaitMs();
    this.reauthorize = options.reauthorize;
  }

  private wake(job: Job) {
    for (const resolve of [...job.changed]) resolve();
  }
  private blockCleanup(job: Job) {
    if (job.status === "running") job.status = "failed";
    // A proof that arrived before the result already settles this job.
    if (job.cleanupProven) return;
    job.cleanupUnconfirmed = true;
    this.unproven.add(job);
    this.cleanupBlocked = true;
    for (const other of this.jobs.values()) {
      // A canceled peer may still be executing until its own result or proof
      // arrives: keep the fence until then too.
      if (other.finished === undefined && !other.cleanupProven)
        this.unproven.add(other);
      this.stop(other, "canceled");
    }
    logger.warn("project tools fenced: job cleanup unconfirmed", {
      job_id: job.id,
      unproven: this.unproven.size,
    });
  }
  private cleanupProven(job: Job) {
    job.cleanupProven = true;
    const fenced = this.unproven.delete(job);
    // The root-owned supervisor attests that each fenced job's scope is gone,
    // so no execution authority is unaccounted for: reopen. A job that never
    // gets a proof keeps the controller fenced. Closing is separate and final.
    if (fenced)
      logger.info("fenced job cleanup proven", {
        job_id: job.id,
        unproven: this.unproven.size,
      });
    if (this.cleanupBlocked && this.unproven.size === 0) {
      this.cleanupBlocked = false;
      logger.info("project tools reopened: every fenced job's cleanup proven");
      this.wakeReopened();
    }
  }
  private wakeReopened() {
    for (const resolve of [...this.reopened]) resolve();
  }
  /** Wait (bounded) for a fence to lift; returns how long it waited. */
  private async waitForReopen(): Promise<number> {
    if (
      !this.cleanupBlocked ||
      this.closed ||
      this.paused ||
      this.fenceWaitMs <= 0
    )
      return 0;
    const started = Date.now();
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.reopened.delete(done);
        resolve();
      };
      const timer = setTimeout(done, this.fenceWaitMs);
      this.reopened.add(done);
    });
    return Date.now() - started;
  }
  /** Wait out a fence, then recheck authority; returns how long it waited. */
  private async admitAfterFence(): Promise<number> {
    const waited = await this.waitForReopen();
    if (waited > 0 && !this.cleanupBlocked) await this.reauthorize?.();
    return waited;
  }
  private fenceError(waitedMs = 0): Error {
    return Error(
      cleanupUnconfirmed(
        [...this.unproven].filter((job) => !job.transient).map((job) => job.id),
        waitedMs,
      ),
    );
  }
  private prune() {
    for (const [id, job] of this.jobs)
      if (
        job.finished !== undefined &&
        (job.transient || Date.now() - job.finished > RETENTION)
      )
        this.jobs.delete(id);
  }
  private assertOpen(waitedMs = 0) {
    if (this.cleanupBlocked) throw this.fenceError(waitedMs);
    if (this.closed || this.paused) throw Error("Project tool is closed");
  }
  private get(id: unknown): Job {
    this.prune();
    const job = typeof id === "string" ? this.jobs.get(id) : undefined;
    if (!job)
      throw Error(
        "Unknown or expired project job; list jobs before starting a replacement",
      );
    return job;
  }
  private append(job: Job, stream: "stdout" | "stderr", data: string) {
    // Bound both bytes and object count, including pathological one-byte output.
    for (let i = 0; i < data.length;) {
      let end = Math.min(i + 4096, data.length);
      if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--;
      const part = data.slice(i, end);
      i = end;
      const bytes = Buffer.byteLength(part);
      job.output.push({ seq: job.next++, stream, data: part, bytes });
      job.bytes += bytes;
      while (job.bytes > OUTPUT_BYTES || job.output.length > 512)
        job.bytes -= job.output.shift()!.bytes;
    }
    this.wake(job);
  }
  async start(args: Record<string, unknown>) {
    // A brief fence lifts within seconds: wait for it rather than fail.
    // (no await unless fenced, so an open call keeps its ordering)
    const waited = this.cleanupBlocked ? await this.admitAfterFence() : 0;
    this.assertOpen(waited);
    const { script, cwd, request_id: requestId } = args;
    if (
      typeof script !== "string" ||
      !script.trim() ||
      Buffer.byteLength(script) > 32 * 1024 ||
      (cwd !== undefined && (typeof cwd !== "string" || cwd.length > 4096)) ||
      (requestId !== undefined &&
        (typeof requestId !== "string" || !requestId || requestId.length > 128))
    )
      throw Error("Invalid project command");
    const timeoutMs = integer(args.timeout_ms, DEFAULT_TIMEOUT, MAX_TIMEOUT);
    if (!timeoutMs) throw Error("Command timeout must be positive");
    // The fence wait counts against the caller's wait (one bridge socket).
    const waitMs = Math.max(
      0,
      integer(args.yield_time_ms, DEFAULT_WAIT, MAX_WAIT) - waited,
    );
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([script, cwd, timeoutMs]))
      .digest("hex");
    this.prune();
    if (requestId) {
      const previous = this.requests.get(requestId as string);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw Error(
            "Project request ID was already used with different command options",
          );
        return this.wait({
          job_id: previous.jobId,
          cursor: 0,
          yield_time_ms: waitMs,
        });
      }
      if (this.requests.size >= 1024)
        throw Error("Project retry-ID capacity reached for this controller");
    }
    const job = this.createJob(
      timeoutMs,
      fingerprint,
      requestId as string | undefined,
    );
    // Keep bounded tombstones even when output expires, so a retry never reruns
    // an old command whose completion was not received by the caller.
    if (job.requestId)
      this.requests.set(job.requestId, { fingerprint, jobId: job.id });
    job.done = this.run(job, script, cwd as string | undefined, {
      timeoutMs,
      onOutput: (stream, data) => this.append(job, stream, data),
      onCleanupConfirmed: () => {},
    }).then(
      () => {},
      () => {},
    );
    return this.wait({ job_id: job.id, cursor: 0, yield_time_ms: waitMs });
  }

  /** File/image/memory steps share host admission and command cleanup fencing. */
  readonly executeTool: ProjectJobExecutor = async (
    script,
    cwd,
    signal,
    options,
  ) => {
    // (no await unless fenced, so an open call keeps its ordering)
    const waited = this.cleanupBlocked ? await this.admitAfterFence() : 0;
    this.assertOpen(waited);
    signal.throwIfAborted();
    const job = this.createJob(options.timeoutMs, "", undefined, true);
    const abort = () => this.stop(job, "canceled");
    signal.addEventListener("abort", abort, { once: true });
    const result = this.run(job, script, cwd, options)
      .then((result) => {
        if (result.cleanupConfirmed !== true) throw this.fenceError();
        job.abort.signal.throwIfAborted();
        return result;
      })
      .finally(() => signal.removeEventListener("abort", abort));
    job.done = result.then(
      () => {},
      () => {},
    );
    return result;
  };

  private createJob(
    timeoutMs: number,
    fingerprint: string,
    requestId?: string,
    transient = false,
  ): Job {
    this.assertOpen();
    this.prune();
    if (
      !transient &&
      [...this.jobs.values()].filter(
        (job) => !job.transient && job.finished === undefined,
      ).length >= 4
    )
      throw Error(
        "Four project jobs are already running; wait or cancel before starting another",
      );
    if (activeJobs >= 64)
      throw Error(
        "Project host command capacity reached; wait before starting another job",
      );
    // File/image/memory steps use host capacity, not command slots or history.
    if (
      !transient &&
      [...this.jobs.values()].filter((job) => !job.transient).length >= 32
    ) {
      const oldest = [...this.jobs.values()].find(
        (job) => !job.transient && job.finished !== undefined,
      );
      if (!oldest) throw Error("Project job limit reached");
      this.jobs.delete(oldest.id);
    }
    const job: Job = {
      id: randomUUID(),
      transient,
      requestId,
      fingerprint,
      abort: new AbortController(),
      status: "running",
      code: null,
      started: Date.now(),
      deadline: Date.now() + timeoutMs,
      output: [],
      bytes: 0,
      next: 0,
      changed: new Set(),
      done: Promise.resolve(),
    };
    this.jobs.set(job.id, job);
    return job;
  }

  private run(
    job: Job,
    script: string,
    cwd: string | undefined,
    options: Parameters<ProjectJobExecutor>[3],
  ): Promise<SandboxExecResult> {
    const reservation = reserve(job);
    let executionStarted = false;
    const timer = setTimeout(
      () => this.stop(job, "timed_out"),
      options.timeoutMs,
    );
    return Promise.resolve()
      .then(() => {
        job.abort.signal.throwIfAborted();
        executionStarted = true;
        return this.execute(script, cwd, job.abort.signal, {
          ...options,
          onCleanupConfirmed: () => {
            reservation.confirmCleanup();
            this.cleanupProven(job);
          },
        });
      })
      .then((result) => {
        if (result.cleanupConfirmed !== true) {
          // Stop the other jobs too; never grant more work after losing the
          // ability to account for execution authority in this controller.
          this.blockCleanup(job);
        } else {
          // Confirmed at exit: this job no longer holds a fence open.
          this.cleanupProven(job);
        }
        if (!job.transient) {
          if (result.stdout) this.append(job, "stdout", result.stdout);
          if (result.stderr) this.append(job, "stderr", result.stderr);
        }
        job.code = result.code;
        if (job.status === "running")
          job.status = result.code === 0 ? "completed" : "failed";
        return result;
      })
      .catch((error) => {
        if (executionStarted) {
          this.blockCleanup(job);
          this.append(job, "stderr", this.fenceError().message);
        } else {
          // Stopped before it was handed to the executor: nothing ran, so it
          // holds no fence (it may be a peer a fence just stopped).
          this.cleanupProven(job);
        }
        if (job.status === "running") {
          job.status = "failed";
          this.append(job, "stderr", "Project command failed to execute");
        }
        throw executionStarted ? this.fenceError() : error;
      })
      .finally(() => {
        clearTimeout(timer);
        reservation.settle();
        this.wake(job);
      });
  }
  async wait(args: Record<string, unknown>) {
    const job = this.get(args.job_id);
    const cursor = integer(args.cursor, 0, Number.MAX_SAFE_INTEGER);
    if (cursor > job.next) throw Error("Output cursor is ahead of this job");
    const waitMs = integer(args.yield_time_ms, DEFAULT_WAIT, MAX_WAIT);
    const ready = () => {
      if (job.status !== "running" || cursor < (job.output[0]?.seq ?? job.next))
        return true;
      let bytes = 0;
      for (const chunk of job.output) {
        if (chunk.seq < cursor) continue;
        bytes += chunk.bytes;
        if (bytes >= PAGE_BYTES) return true;
      }
      return false;
    };
    if (!ready() && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          job.changed.delete(changed);
          this.waits.delete(done);
          resolve();
        };
        const changed = () => {
          if (ready()) done();
        };
        const timer = setTimeout(done, waitMs);
        job.changed.add(changed);
        this.waits.add(done);
      });
    }
    const first = job.output[0]?.seq ?? job.next;
    let next = Math.max(cursor, first),
      bytes = 0,
      stdout = "",
      stderr = "";
    for (const chunk of job.output) {
      if (chunk.seq < next) continue;
      if (bytes + chunk.bytes > PAGE_BYTES) break;
      bytes += chunk.bytes;
      next = chunk.seq + 1;
      if (chunk.stream === "stdout") stdout += chunk.data;
      else stderr += chunk.data;
    }
    return {
      job_id: job.id,
      status: job.status,
      code: job.code,
      stdout,
      stderr,
      next_cursor: next,
      has_more: next < job.next,
      output_truncated: cursor < first,
      started_at: job.started,
      deadline: job.deadline,
      finished_at: job.finished,
      cleanup_pending: job.status !== "running" && job.finished === undefined,
      cleanup_error: job.cleanupUnconfirmed
        ? "Runtime could not verify job cleanup"
        : undefined,
    };
  }
  private stop(job: Job, status: "canceled" | "timed_out") {
    if (job.status !== "running") return;
    job.status = status;
    job.abort.abort();
    this.wake(job);
  }
  async cancel(args: Record<string, unknown>) {
    const job = this.get(args.job_id);
    this.stop(job, "canceled");
    await job.done;
    // Report the outcome, not old output: pass a cursor to read output.
    return this.wait({
      ...args,
      cursor: args.cursor ?? job.next,
      yield_time_ms: 0,
    });
  }
  list() {
    this.prune();
    return {
      jobs: [...this.jobs.values()]
        .filter((job) => !job.transient)
        .map((job) => ({
          job_id: job.id,
          request_id: job.requestId,
          status: job.status,
          code: job.code,
          started_at: job.started,
          deadline: job.deadline,
          finished_at: job.finished,
          cleanup_pending:
            job.status !== "running" && job.finished === undefined,
          cleanup_error: job.cleanupUnconfirmed
            ? "Runtime could not verify job cleanup"
            : undefined,
        })),
    };
  }
  async cancelAll() {
    this.paused = true;
    this.wakeReopened();
    const jobs = [...this.jobs.values()];
    for (const job of jobs) this.stop(job, "canceled");
    await Promise.all(jobs.map((job) => job.done));
  }
  resume() {
    if (!this.closed) this.paused = false;
  }
  /** Return every pending wait now, with whatever output is available. */
  releaseWaits() {
    for (const done of [...this.waits]) done();
  }
  async close() {
    this.closed = true;
    this.wakeReopened();
    await this.cancelAll();
    // The runtime retains only the recovery callback after close, not output.
    for (const job of this.jobs.values()) job.output = [];
    this.jobs.clear();
    this.requests.clear();
  }
  get running() {
    return [...this.jobs.values()].some((job) => job.status === "running");
  }
}
