/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { createHash, randomUUID } from "node:crypto";
import type { SandboxExecResult } from "@cocalc/project-runner/run/sandbox-exec";

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
  requestId?: string;
  fingerprint: string;
  abort: AbortController;
  status: Status;
  code: number | null;
  started: number;
  finished?: number;
  cleanupUnconfirmed?: boolean;
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
const MAX_TIMEOUT = 86_400_000;
const RETENTION = 600_000;
const OUTPUT_BYTES = 1024 * 1024;
// Says who can recover and how: an agent cannot, and retrying does not help.
const CLEANUP_UNCONFIRMED =
  "Project job cleanup is unconfirmed, so this agent session cannot start more project commands. Only the user can recover: ask them to restart the project (project Settings, Restart). Waiting or retrying will not help.";
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
  constructor(private execute: ProjectJobExecutor) {}

  private wake(job: Job) {
    for (const resolve of [...job.changed]) resolve();
  }
  private blockCleanup(job: Job) {
    job.cleanupUnconfirmed = true;
    this.cleanupBlocked = true;
    if (job.status === "running") job.status = "failed";
    for (const other of this.jobs.values()) this.stop(other, "canceled");
  }
  private prune() {
    for (const [id, job] of this.jobs)
      if (job.finished !== undefined && Date.now() - job.finished > RETENTION)
        this.jobs.delete(id);
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
    for (let i = 0; i < data.length; ) {
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
    if (this.cleanupBlocked) throw Error(CLEANUP_UNCONFIRMED);
    if (this.closed || this.paused) throw Error("Project tool is closed");
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
    const waitMs = integer(args.yield_time_ms, DEFAULT_WAIT, 30_000);
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
    if (
      [...this.jobs.values()].filter((job) => job.finished === undefined)
        .length >= 4
    )
      throw Error(
        "Four project jobs are already running; wait or cancel before starting another",
      );
    if (activeJobs >= 64)
      throw Error(
        "Project host command capacity reached; wait before starting another job",
      );
    if (this.jobs.size >= 32) {
      const oldest = [...this.jobs.values()].find(
        (job) => job.finished !== undefined,
      );
      if (!oldest) throw Error("Project job limit reached");
      this.jobs.delete(oldest.id);
    }
    const job: Job = {
      id: randomUUID(),
      requestId: requestId as string | undefined,
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
    // Keep bounded tombstones even when output expires, so a retry never reruns
    // an old command whose completion was not received by the caller.
    if (job.requestId)
      this.requests.set(job.requestId, { fingerprint, jobId: job.id });
    const reservation = reserve(job);
    let executionStarted = false;
    const timer = setTimeout(() => this.stop(job, "timed_out"), timeoutMs);
    job.done = Promise.resolve()
      .then(() => {
        job.abort.signal.throwIfAborted();
        executionStarted = true;
        return this.execute(
          script,
          cwd as string | undefined,
          job.abort.signal,
          {
            timeoutMs,
            onOutput: (stream, data) => this.append(job, stream, data),
            onCleanupConfirmed: reservation.confirmCleanup,
          },
        );
      })
      .then((result) => {
        if (result.cleanupConfirmed !== true) {
          // Stop the other jobs too; never grant more work after losing the
          // ability to account for execution authority in this controller.
          this.blockCleanup(job);
        }
        if (result.stdout) this.append(job, "stdout", result.stdout);
        if (result.stderr) this.append(job, "stderr", result.stderr);
        job.code = result.code;
        if (job.status === "running")
          job.status = result.code === 0 ? "completed" : "failed";
      })
      .catch(() => {
        if (executionStarted) {
          this.blockCleanup(job);
          this.append(job, "stderr", CLEANUP_UNCONFIRMED);
        }
        if (job.status === "running") {
          job.status = "failed";
          this.append(job, "stderr", "Project command failed to execute");
        }
      })
      .finally(() => {
        clearTimeout(timer);
        reservation.settle();
        this.wake(job);
      });
    return this.wait({ job_id: job.id, cursor: 0, yield_time_ms: waitMs });
  }
  async wait(args: Record<string, unknown>) {
    const job = this.get(args.job_id);
    const cursor = integer(args.cursor, 0, Number.MAX_SAFE_INTEGER);
    if (cursor > job.next) throw Error("Output cursor is ahead of this job");
    const waitMs = integer(args.yield_time_ms, DEFAULT_WAIT, 30_000);
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
          resolve();
        };
        const changed = () => {
          if (ready()) done();
        };
        const timer = setTimeout(done, waitMs);
        job.changed.add(changed);
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
      jobs: [...this.jobs.values()].map((job) => ({
        job_id: job.id,
        request_id: job.requestId,
        status: job.status,
        code: job.code,
        started_at: job.started,
        deadline: job.deadline,
        finished_at: job.finished,
        cleanup_pending: job.status !== "running" && job.finished === undefined,
        cleanup_error: job.cleanupUnconfirmed
          ? "Runtime could not verify job cleanup"
          : undefined,
      })),
    };
  }
  async cancelAll() {
    this.paused = true;
    const jobs = [...this.jobs.values()];
    for (const job of jobs) this.stop(job, "canceled");
    await Promise.all(jobs.map((job) => job.done));
  }
  resume() {
    if (!this.closed) this.paused = false;
  }
  async close() {
    this.closed = true;
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
