/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Durable jobs (`run`) in direct mode. Plan:
// src/.agents/computers-plan-2026-10-11.md ("Jobs").
//
// - Each job has a directory: spec.json, status.json, log, and exit_code.
// - It runs in its own session and process group, through a small /bin/sh
//   wrapper that writes the command's exit code itself, so a job that ends
//   while the daemon is down still has an outcome. The daemon finds a job
//   again by pid AND process start time (a reused pid is not the job).
// - nice (and ionice on Linux) unless the job asked for --no-nice.
// - Exclusive: a bounded queue. An exclusive job starts when no job runs,
//   and jobs submitted after it wait until it is done.
// - Retention: 7 days or 1 GB, oldest first.
// - Who sees what (the access matrix): other agents see a job's command
//   line and description, but only its own agent reads its log or kills it.

import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { isValidUUID } from "@cocalc/util/misc";
import { ensurePrivateDir, readJson, writeDurableJson } from "./durable";
import { loginShell } from "./exec";
import {
  leaderAlive,
  processStartTime,
  RELEASE_PRELUDE,
  signalVerifiedGroup,
  STAY_LEADER,
} from "./launch";
import { systemBootClock, type BootClock } from "./clock";

export type JobState =
  | "queued"
  /** Recorded before it is spawned; released only once its pid is durable. */
  | "starting"
  | "running"
  | "exited"
  | "killed"
  | "cancelled"
  | "lost";

export interface JobSpec {
  job_id: string;
  operation_id: string;
  agent_id: string;
  source_project_id: string;
  name: string | null;
  description: string;
  command: string;
  /** Resolved absolute working directory. */
  cwd: string;
  nice: boolean;
  exclusive: boolean;
  created_at: number;
  /** What admitted it, re-checked before a queued job starts. */
  auth: JobAuthorization;
}

export interface JobAuthorization {
  computer_epoch: number;
  policy_epoch: number;
  /** The source project's privacy epoch from its attestation. */
  privacy_epoch: number;
  /** Wall-clock time after which the job is stopped (ticket and session). */
  deadline_at: number | null;
  /**
   * The same deadline on this boot's monotonic clock (Linux), so setting the
   * wall clock back doesn't extend it, even across daemon restarts.
   */
  boot_id?: string | null;
  boot_deadline_ms?: number | null;
}

export interface JobStatus {
  state: JobState;
  pid: number | null;
  /** Process start time as the OS reports it, to tell a reused pid apart. */
  pid_start: string | null;
  started_at: number | null;
  ended_at: number | null;
  exit_code: number | null;
  error: string | null;
  kill_requested: boolean;
  /** When SIGTERM was first sent; SIGKILL follows after the grace period. */
  kill_started_at?: number | null;
  /** The same moment on this boot's clock (Linux), so a wall-clock jump
   * can't postpone SIGKILL. */
  kill_started_boot?: { boot_id: string; since_boot_ms: number } | null;
}

export type Job = JobSpec & JobStatus;

/** What every agent of the network may see about any job. */
export interface JobSummary {
  job_id: string;
  name: string | null;
  agent_id: string;
  command: string;
  description: string;
  state: JobState;
  exclusive: boolean;
  started_at: number | null;
  ended_at: number | null;
  exit_code: number | null;
  /** True for the asking agent's own jobs (it may read logs and kill). */
  own: boolean;
}

export const MAX_QUEUED_JOBS = 20;
export const MAX_QUEUE_AGE_MS = 24 * 60 * 60 * 1000;
export const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const JOB_RETENTION_BYTES = 1024 ** 3;
const LOG_TAIL_READ_BYTES = 4 * 1024 * 1024;
/** A job's log keeps at most this much; the rest is drained and counted. */
export const JOB_LOG_CAP_BYTES = 256 * 1024 * 1024;

const WRAPPER = `${RELEASE_PRELUDE}
cmd=$COCALC_JOB_COMMAND
exit_file=$COCALC_JOB_EXIT_FILE
job_shell=$COCALC_JOB_SHELL
job_nice=$COCALC_JOB_NICE
log_cap=$COCALC_JOB_LOG_CAP
unset COCALC_JOB_COMMAND COCALC_JOB_EXIT_FILE COCALC_JOB_SHELL COCALC_JOB_NICE COCALC_JOB_LOG_CAP
if [ -n "$job_nice" ]; then
  if command -v ionice >/dev/null 2>&1; then
    set -- ionice -c 3 nice -n 10
  else
    set -- nice -n 10
  fi
else
  set --
fi
# The log keeps at most log_cap bytes; the rest is read and dropped (so the
# command never dies of a closed pipe) and counted at the end.
{
  "$@" "$job_shell" -lc "$cmd"
  code=$?
  printf '%s\\n' "$code" > "$exit_file.tmp" && mv -f "$exit_file.tmp" "$exit_file"
} 2>&1 | {
  head -c "$log_cap"
  rest=$(wc -c | tr -d ' ')
  if [ "$rest" -gt 0 ]; then
    printf '\\n[cocalc: log capped; %s more bytes not kept]\\n' "$rest"
  fi
} &
# The command started before this, so it doesn't inherit it: the leader
# survives SIGTERM and leaves only once the job is gone (or by SIGKILL).
trap '' TERM HUP INT
wait
${STAY_LEADER}
code=$(cat "$exit_file" 2>/dev/null)
exit "\${code:-1}"
`;

export class JobError extends Error {}

export { processStartTime };

export class JobManager {
  private readonly dir: string;

  constructor(
    stateDir: string,
    private readonly opts: {
      shell?: string;
      killGraceMs?: number;
      logCapBytes?: number;
      onEnded?: (job: Job) => void;
      /**
       * Before a queued job starts: why it may no longer run (authorization
       * changed, session ended), or null to start it.
       */
      authorize?: (job: Job) => string | null;
      bootClock?: BootClock;
      /** Tests only: called at each launch boundary (to crash or fail). */
      launchHook?: (
        point: "starting" | "spawned" | "recorded" | "released",
      ) => void;
    } = {},
  ) {
    this.dir = join(stateDir, "jobs");
    ensurePrivateDir(this.dir);
  }

  private jobDir(job_id: string): string {
    if (!isValidUUID(job_id)) throw new JobError("bad job id");
    return join(this.dir, job_id);
  }

  get(job_id: string): Job | undefined {
    let dir: string;
    try {
      dir = this.jobDir(job_id);
    } catch {
      return undefined;
    }
    const spec = readJson<JobSpec>(join(dir, "spec.json"));
    const status = readJson<JobStatus>(join(dir, "status.json"));
    if (spec == null || status == null) return undefined;
    return { ...spec, ...status };
  }

  private setStatus(job_id: string, patch: Partial<JobStatus>): Job {
    const job = this.get(job_id);
    if (job == null) throw new JobError(`no job ${job_id}`);
    const status: JobStatus = {
      state: job.state,
      pid: job.pid,
      pid_start: job.pid_start,
      started_at: job.started_at,
      ended_at: job.ended_at,
      exit_code: job.exit_code,
      error: job.error,
      kill_requested: job.kill_requested,
      kill_started_at: job.kill_started_at ?? null,
      ...patch,
    };
    writeDurableJson(join(this.jobDir(job_id), "status.json"), status);
    return { ...job, ...status };
  }

  list(): Job[] {
    const jobs: Job[] = [];
    for (const name of readdirSync(this.dir)) {
      const job = this.get(name);
      if (job != null) jobs.push(job);
    }
    return jobs.sort((a, b) => a.created_at - b.created_at);
  }

  /** Jobs that may have processes: running, or starting with a pid. */
  private running(): Job[] {
    return this.list().filter(isLive);
  }

  private queued(): Job[] {
    return this.list().filter((j) => j.state === "queued");
  }

  /**
   * Record a job and start it, or queue it behind an exclusive job (or as
   * an exclusive job behind running ones). Returns the job as recorded.
   */
  submit(spec: Omit<JobSpec, "created_at">, now = Date.now()): Job {
    this.refresh(now);
    const queued = this.queued();
    const running = this.running();
    const mustWait =
      queued.length > 0 ||
      running.some((j) => j.exclusive) ||
      (spec.exclusive && running.length > 0);
    if (mustWait && queued.length >= MAX_QUEUED_JOBS) {
      throw new JobError("too many queued jobs on this computer");
    }
    const dir = this.jobDir(spec.job_id);
    if (existsSync(dir)) throw new JobError("job already exists");
    ensurePrivateDir(dir);
    writeDurableJson(join(dir, "spec.json"), { ...spec, created_at: now });
    writeDurableJson(join(dir, "status.json"), {
      state: "queued",
      pid: null,
      pid_start: null,
      started_at: null,
      ended_at: null,
      exit_code: null,
      error: null,
      kill_requested: false,
    } satisfies JobStatus);
    if (!mustWait) return this.start(spec.job_id, now);
    return this.get(spec.job_id)!;
  }

  /**
   * Start a job, crash-safely:
   * 1. record it as "starting" (so a restart never dispatches it again);
   * 2. spawn the wrapper, which waits on fd 3;
   * 3. record its pid and start time durably;
   * 4. only then release it ("go" on fd 3).
   * A crash before 4 closes fd 3 and the wrapper exits without running the
   * command; refresh() then cancels a "starting" job that has no pid.
   */
  private start(job_id: string, now: number): Job {
    const job = this.setStatus(job_id, { state: "starting" });
    this.opts.launchHook?.("starting");
    const dir = this.jobDir(job_id);
    const log = openSync(join(dir, "log"), "a", 0o600);
    let child;
    try {
      child = spawn("/bin/sh", ["-c", WRAPPER, "cocalc-job"], {
        cwd: job.cwd,
        detached: true,
        stdio: ["ignore", log, log, "pipe"],
        env: {
          ...process.env,
          COCALC_JOB_COMMAND: job.command,
          COCALC_JOB_EXIT_FILE: join(dir, "exit_code"),
          COCALC_JOB_SHELL: this.opts.shell ?? loginShell(),
          COCALC_JOB_NICE: job.nice ? "1" : "",
          COCALC_JOB_LOG_CAP: `${this.opts.logCapBytes ?? JOB_LOG_CAP_BYTES}`,
        },
      });
    } finally {
      closeSync(log);
    }
    child.on("error", () => {});
    const release = child.stdio[3] as import("node:stream").Writable;
    release.on("error", () => {});
    child.unref();
    if (child.pid == null) {
      return this.setStatus(job_id, {
        state: "lost",
        ended_at: now,
        error: "the job could not be started",
      });
    }
    try {
      this.opts.launchHook?.("spawned");
      this.setStatus(job_id, {
        pid: child.pid,
        pid_start: processStartTime(child.pid) ?? null,
        started_at: now,
      });
    } catch (err) {
      // Not recorded, so never released: closing fd 3 ends the wrapper.
      release.destroy();
      throw err;
    }
    this.opts.launchHook?.("recorded");
    release.end("go\n");
    (release as any).unref?.();
    this.opts.launchHook?.("released");
    return this.setStatus(job_id, { state: "running" });
  }

  private exitCode(job_id: string): number | undefined {
    try {
      const text = readFileSync(join(this.jobDir(job_id), "exit_code"), "utf8");
      const code = Number(text.trim());
      return Number.isInteger(code) ? code : undefined;
    } catch {
      return undefined;
    }
  }

  /** The job's group leader (the wrapper), verified by pid and start time. */
  private alive(job: Job): boolean {
    return leaderAlive(job.pid, job.pid_start);
  }

  private signalGroup(job: Job, signal: NodeJS.Signals): void {
    signalVerifiedGroup(job.pid, job.pid_start, signal);
  }

  /** Has the job reached its time limit (wall clock, or this boot's clock)? */
  deadlinePassed(job: Job, now: number): boolean {
    const a = job.auth;
    if (a.deadline_at != null && now >= a.deadline_at) return true;
    if (
      a.boot_id != null &&
      a.boot_deadline_ms != null &&
      a.boot_id === this.bootClock.bootId()
    ) {
      const since = this.bootClock.sinceBootMs();
      if (since != null && since >= a.boot_deadline_ms) return true;
    }
    return false;
  }

  private bootMoment(): { boot_id: string; since_boot_ms: number } | null {
    const boot_id = this.bootClock.bootId();
    const since_boot_ms = this.bootClock.sinceBootMs();
    return boot_id != null && since_boot_ms != null
      ? { boot_id, since_boot_ms }
      : null;
  }

  /** Has the SIGTERM grace period passed (wall clock, or this boot's)? */
  private graceOver(job: Job, now: number): boolean {
    const grace = this.opts.killGraceMs ?? 5000;
    if (job.kill_started_at != null && now - job.kill_started_at >= grace) {
      return true;
    }
    const b = job.kill_started_boot;
    if (b != null && b.boot_id === this.bootClock.bootId()) {
      const since = this.bootClock.sinceBootMs();
      if (since != null && since - b.since_boot_ms >= grace) return true;
    }
    return false;
  }

  private get bootClock(): BootClock {
    return this.opts.bootClock ?? systemBootClock;
  }

  /**
   * Start stopping a job: record it durably, then SIGTERM its process
   * group. refresh() sends SIGKILL once the grace period has passed, also
   * after a daemon restart, until nothing of it is left.
   */
  private requestKill(job: Job, reason: string | null, now: number): void {
    this.setStatus(job.job_id, {
      kill_requested: true,
      kill_started_at: job.kill_started_at ?? now,
      kill_started_boot: job.kill_started_boot ?? this.bootMoment(),
      ...(reason != null && job.error == null ? { error: reason } : {}),
    });
    this.signalGroup(job, "SIGTERM");
  }

  /**
   * Bring statuses up to date (jobs that ended, including while the daemon
   * was down), expire old queued jobs, and start whatever may start now.
   */
  refresh(now = Date.now()): void {
    for (const job of this.list()) {
      if (job.state === "starting" && job.pid == null) {
        // Recorded but never spawned or recorded: it was never released, so
        // the command didn't run.
        this.ended(
          job.job_id,
          {
            state: "cancelled",
            error: "the daemon stopped before the job started; it did not run",
          },
          now,
        );
        continue;
      }
      if (!isLive(job)) {
        if (job.state === "queued" && now - job.created_at > MAX_QUEUE_AGE_MS) {
          this.ended(
            job.job_id,
            { state: "cancelled", error: "queued for too long" },
            now,
          );
        }
        continue;
      }
      const alive = this.alive(job);
      if (alive && !job.kill_requested && this.deadlinePassed(job, now)) {
        this.requestKill(job, "the job reached its time limit", now);
        continue;
      }
      if (alive && job.kill_requested) {
        // Escalate: a job that ignores SIGTERM gets SIGKILL after the grace
        // period, also when the daemon restarted in between.
        if (job.kill_started_at == null) {
          this.requestKill(job, null, now);
        } else if (this.graceOver(job, now)) {
          this.signalGroup(job, "SIGKILL");
        }
        continue;
      }
      // The leader stays while anything of the job is left (Linux), so a
      // live leader means a live job.
      if (alive) continue;
      const code = this.exitCode(job.job_id);
      if (job.kill_requested) {
        this.ended(
          job.job_id,
          { state: "killed", ...(job.error ? { error: job.error } : {}) },
          now,
        );
      } else if (code != null) {
        this.ended(job.job_id, { state: "exited", exit_code: code }, now);
      } else {
        this.ended(
          job.job_id,
          { state: "lost", error: "the job ended without an exit code" },
          now,
        );
      }
    }
    this.dispatch(now);
  }

  private ended(job_id: string, patch: Partial<JobStatus>, now: number): void {
    const job = this.setStatus(job_id, { ended_at: now, ...patch });
    this.opts.onEnded?.(job);
  }

  private dispatch(now: number): void {
    for (const job of this.queued()) {
      const running = this.running();
      if (running.some((j) => j.exclusive)) return;
      if (job.exclusive && running.length > 0) return;
      const refused = this.opts.authorize?.(job) ?? null;
      if (refused != null) {
        this.ended(job.job_id, { state: "cancelled", error: refused }, now);
        continue;
      }
      this.start(job.job_id, now);
      if (job.exclusive) return;
    }
  }

  /**
   * Cancel queued jobs (all, or one agent's or one project's). Queued work
   * is authorized again at dispatch, so any floor change cancels it.
   */
  cancelQueued(
    reason: string,
    filter: (job: Job) => boolean = () => true,
    now = Date.now(),
  ): string[] {
    const cancelled: string[] = [];
    for (const job of this.queued()) {
      if (!filter(job)) continue;
      this.ended(job.job_id, { state: "cancelled", error: reason }, now);
      cancelled.push(job.job_id);
    }
    return cancelled;
  }

  /** Kill one of the asking agent's jobs. */
  kill(job_id: string, agent_id: string, now = Date.now()): Job {
    const job = this.get(job_id);
    if (job == null || job.agent_id !== agent_id) {
      throw new JobError("no such job of yours");
    }
    if (job.state === "queued") {
      this.ended(
        job_id,
        { state: "cancelled", error: "killed while queued" },
        now,
      );
      return this.get(job_id)!;
    }
    if (!isLive(job)) return job;
    this.requestKill(job, null, now);
    return this.get(job_id)!;
  }

  /** Stop running jobs that match (e.g. one project's, when it changed). */
  killWhere(filter: (job: Job) => boolean, reason: string): string[] {
    const killed: string[] = [];
    for (const job of this.running()) {
      if (!filter(job)) continue;
      this.requestKill(job, reason, Date.now());
      killed.push(job.job_id);
    }
    return killed;
  }

  /** At the deadline or on revocation: kill everything (best effort). */
  killAll(reason: string, now = Date.now()): void {
    this.cancelQueued(reason, () => true, now);
    for (const job of this.running()) {
      this.requestKill(job, reason, now);
    }
  }

  /** The last lines of one of the asking agent's jobs' log. */
  logs(job_id: string, agent_id: string, tailLines: number): string {
    const job = this.get(job_id);
    if (job == null || job.agent_id !== agent_id) {
      throw new JobError("no such job of yours");
    }
    const path = join(this.jobDir(job_id), "log");
    if (!existsSync(path)) return "";
    const size = statSync(path).size;
    const length = Math.min(size, LOG_TAIL_READ_BYTES);
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buffer, 0, length, size - length);
    } finally {
      closeSync(fd);
    }
    const lines = buffer.toString("utf8").split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-tailLines).join("\n");
  }

  /** Jobs that hold or will hold processes: running and queued. */
  activeCount(agent_id?: string): number {
    return this.list().filter(
      (j) =>
        (j.state === "running" ||
          j.state === "starting" ||
          j.state === "queued") &&
        (agent_id == null || j.agent_id === agent_id),
    ).length;
  }

  /** Every job, as the asking agent may see it. */
  summaries(agent_id: string): JobSummary[] {
    return this.list().map((job) => ({
      job_id: job.job_id,
      name: job.name,
      agent_id: job.agent_id,
      command: job.command,
      description: job.description,
      state: job.state,
      exclusive: job.exclusive,
      started_at: job.started_at,
      ended_at: job.ended_at,
      exit_code: job.exit_code,
      own: job.agent_id === agent_id,
    }));
  }

  /** Remove finished jobs older than 7 days, then the oldest above 1 GB. */
  prune(
    now = Date.now(),
    maxAgeMs = JOB_RETENTION_MS,
    maxBytes = JOB_RETENTION_BYTES,
  ): string[] {
    const finished = this.list().filter(
      (j) => !isLive(j) && j.state !== "queued" && j.state !== "starting",
    );
    const removed: string[] = [];
    const remove = (job: Job) => {
      rmSync(this.jobDir(job.job_id), { recursive: true, force: true });
      removed.push(job.job_id);
    };
    const kept: Job[] = [];
    for (const job of finished) {
      if (now - (job.ended_at ?? job.created_at) > maxAgeMs) remove(job);
      else kept.push(job);
    }
    let total = this.list().reduce((sum, j) => sum + this.size(j.job_id), 0);
    for (const job of kept) {
      if (total <= maxBytes) break;
      total -= this.size(job.job_id);
      remove(job);
    }
    return removed;
  }

  private size(job_id: string): number {
    let total = 0;
    const dir = this.jobDir(job_id);
    for (const name of readdirSync(dir)) {
      try {
        total += statSync(join(dir, name)).size;
      } catch {}
    }
    return total;
  }
}

function isLive(job: Job): boolean {
  return (
    job.state === "running" || (job.state === "starting" && job.pid != null)
  );
}
