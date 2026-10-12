/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The daemon's core in direct mode, independent of how messages arrive:
// admit, record in the ledger, run, answer. The transport (conat, as the
// "computer" principal) and the CLI wrap this.
// Plan: src/.agents/computers-plan-2026-10-11.md ("Architecture", "Jobs").
//
// - exec, run and kill have side effects: a retry with the same
//   operation_id returns the recorded outcome and never runs them again.
//   exec's output is kept on the machine, so a retry still gets it.
// - info, jobs, logs and ops only read: a retry simply reads again.
// - When the session ends: refuse everything, kill every job (best effort in
//   direct mode), cancel the queue.

import { execFile } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statfsSync,
  statSync,
} from "node:fs";
import {
  arch,
  cpus,
  freemem,
  hostname,
  loadavg,
  platform,
  totalmem,
} from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  MAX_EXEC_OUTPUT_BYTES,
  type OperationRequest,
} from "@cocalc/util/computers/operations";
import type { ComputerTicket } from "@cocalc/util/computers/protocol";
import { admit, RateLimiter, type AdmissionInput } from "./admission";
import {
  systemBootClock,
  type BootClock,
  type Clocks,
  type HubClock,
  type SessionClock,
} from "./clock";
import { resolveCwd, runExec, type ExecResult } from "./exec";
import { Cleanups } from "./cleanups";
import { JobManager, type Job, type JobSummary } from "./jobs";
import { captureIdentity } from "./launch";
import { Ledger, LedgerConflict, type LedgerEntry } from "./ledger";
import type { DaemonStore } from "./state";

const execFileAsync = promisify(execFile);

export const LEDGER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Hard limits on what runs at once (execs plus running or queued jobs): in
 * total, and per agent. A ticket's limits.concurrency can only lower the
 * per-agent one.
 */
export const MAX_ACTIVE_OPERATIONS = 16;
export const MAX_ACTIVE_OPERATIONS_PER_AGENT = 4;
/** How often the daemon enforces deadlines on its own, without traffic. */
export const ENFORCEMENT_INTERVAL_MS = 1000;
/** How often the timer forgets old records. */
export const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
/** All exec output kept on the machine, together. */
export const EXEC_OUTPUT_RETENTION_BYTES = 512 * 1024 * 1024;

export type OperationReply =
  | { ok: false; refused: string[] }
  | {
      ok: true;
      operation_id: string;
      /** Whether this answer is a recorded outcome (a retry). */
      replayed: boolean;
      state: LedgerEntry["state"];
      result: unknown;
      error: string | null;
    };

export interface DaemonDeps {
  stateDir: string;
  store: DaemonStore;
  clocks: Clocks;
  hubClock: HubClock;
  session: SessionClock;
  /** Default working directory for commands. */
  workdir: string;
  shell?: string;
  killGraceMs?: number;
  /** Told about every finished operation and ended job (for the hub). */
  report?: (event: DaemonEvent) => void;
  /** Errors from the enforcement timer (it keeps running). */
  onError?: (err: unknown) => void;
  bootClock?: BootClock;
  version?: string;
  /** Tests only: how a process's identity is read. */
  identify?: (pid: number) => string | undefined;
  /** All exec output kept on the machine (default EXEC_OUTPUT_RETENTION_BYTES). */
  execOutputQuotaBytes?: number;
}

export type DaemonEvent =
  | { kind: "operation"; entry: LedgerEntry }
  | { kind: "job"; job: Job };

const SIDE_EFFECTS = new Set(["exec", "run", "kill"]);

export class ComputerDaemon {
  readonly ledger: Ledger;
  readonly jobs: JobManager;
  readonly cleanups: Cleanups;
  private running = new Map<
    string,
    { controller: AbortController; agent_id: string }
  >();
  private ended = false;
  private timer?: ReturnType<typeof setInterval>;
  // Before anything else (messages arrive before they are authenticated), a
  // global bucket; after admission, one per agent.
  private readonly globalLimiter = new RateLimiter(50, 100);
  private readonly agentLimiter = new RateLimiter(10, 30);

  constructor(private readonly deps: DaemonDeps) {
    this.ledger = new Ledger(deps.stateDir);
    this.cleanups = new Cleanups(deps.stateDir, deps.killGraceMs ?? 5000);
    this.jobs = new JobManager(deps.stateDir, {
      shell: deps.shell,
      killGraceMs: deps.killGraceMs,
      onEnded: (job) => this.report({ kind: "job", job }),
      authorize: (job) => this.jobRefusal(job),
      bootClock: deps.bootClock,
      identify: deps.identify,
    });
    // An exec started by a previous daemon may still be running on its
    // own; its outcome is unknown either way, so stop it. Its cleanup record
    // is written BEFORE the ledger marks it unknown, and is ensured again on
    // every start for every in-flight or unknown exec with a recorded
    // identity, so a crash between the two never loses it. Every tick then
    // re-drives it (TERM, then KILL) until the verified leader is gone.
    for (const entry of this.ledger.list()) {
      const r = entry.result as { pid?: number; pid_start?: string } | null;
      if (
        entry.operation === "exec" &&
        ["admitted", "running", "unknown"].includes(entry.state) &&
        r?.pid != null &&
        r.pid_start != null
      ) {
        this.cleanups.add(entry.operation_id, r.pid, r.pid_start);
      }
    }
    for (const operation_id of this.ledger.markInterrupted()) {
      const entry = this.ledger.get(operation_id);
      if (entry != null) this.report({ kind: "operation", entry });
    }
    this.jobs.refresh();
  }

  /** One message from an agent: ticket, proof and request. */
  async handle(input: AdmissionInput): Promise<OperationReply> {
    if (!this.globalLimiter.allow("*", Date.now())) {
      return { ok: false, refused: ["this computer is busy; try again"] };
    }
    this.tick();
    const admission = admit(input, {
      store: this.deps.store,
      hub_now: this.deps.hubClock.now(),
      continuous_now: this.deps.clocks.continuous(),
      session_ended: this.ended,
    });
    if (!admission.ok) return { ok: false, refused: admission.refusals };
    const { ticket, operation } = admission;
    if (!this.agentLimiter.allow(ticket.agent_id, Date.now())) {
      return { ok: false, refused: ["too many operations; slow down"] };
    }
    // A new exec or run must fit the concurrency limits: the smaller of the
    // ticket's and the daemon's per agent, and the daemon's in total. Jobs
    // are counted from disk, so this holds across restarts. A retry of a
    // known operation always gets its recorded answer instead.
    if (
      (operation.operation === "exec" || operation.operation === "run") &&
      this.ledger.get(ticket.operation_id) == null
    ) {
      const mine =
        [...this.running.values()].filter((r) => r.agent_id === ticket.agent_id)
          .length + this.jobs.activeCount(ticket.agent_id);
      const all = this.running.size + this.jobs.activeCount();
      const perAgent = Math.min(
        ticket.limits.concurrency,
        MAX_ACTIVE_OPERATIONS_PER_AGENT,
      );
      if (all >= MAX_ACTIVE_OPERATIONS || mine >= perAgent) {
        return {
          ok: false,
          refused: ["too many operations running on this computer; try again"],
        };
      }
    }

    let begun;
    try {
      begun = this.ledger.begin({
        operation_id: ticket.operation_id,
        operation: ticket.operation,
        request_hash: ticket.request_hash,
        ticket_id: ticket.ticket_id,
        agent_id: ticket.agent_id,
        source_project_id: ticket.source_project_id,
      });
    } catch (err) {
      if (err instanceof LedgerConflict)
        return { ok: false, refused: [err.message] };
      throw err;
    }
    if (!begun.fresh && SIDE_EFFECTS.has(operation.operation)) {
      return this.replay(begun.entry);
    }
    return await this.perform(ticket, operation, !begun.fresh);
  }

  private replay(entry: LedgerEntry): OperationReply {
    let result = entry.result;
    if (entry.operation === "exec" && entry.state !== "admitted") {
      const pruned = !existsSync(this.execDir(entry.operation_id));
      result = {
        ...(entry.result as object),
        ...this.execOutput(entry.operation_id),
        // Its output was removed (retention or quota): say so.
        ...(pruned ? { output_pruned: true } : {}),
      };
    }
    return {
      ok: true,
      operation_id: entry.operation_id,
      replayed: true,
      state: entry.state,
      result,
      error: entry.error,
    };
  }

  private async perform(
    ticket: ComputerTicket,
    op: OperationRequest,
    replayed: boolean,
  ): Promise<OperationReply> {
    const id = ticket.operation_id;
    const agent_id = ticket.agent_id;
    const done = (
      result: unknown,
      extra: { exit_code?: number | null } = {},
    ) => {
      const entry = this.ledger.update(id, {
        state: "done",
        exit_code: extra.exit_code ?? null,
        result: SIDE_EFFECTS.has(op.operation) ? result : null,
      });
      this.report({ kind: "operation", entry });
      return {
        ok: true as const,
        operation_id: id,
        replayed,
        state: entry.state,
        result,
        error: null,
      };
    };
    try {
      switch (op.operation) {
        case "info":
          return done(await this.info());
        case "jobs":
          this.jobs.refresh();
          return done({
            jobs: this.jobs.summaries(agent_id) satisfies JobSummary[],
          });
        case "logs":
          this.jobs.refresh();
          return done({
            log: this.jobs.logs(
              op.request.job_id,
              agent_id,
              op.request.tail_lines,
            ),
          });
        case "ops":
          return done(this.ops(op.request.operation_id, agent_id));
        case "kill": {
          const job = this.jobs.kill(op.request.job_id, agent_id);
          return done({ job_id: job.job_id, state: job.state });
        }
        case "run": {
          const remaining = this.deps.session.remainingMs();
          const job = this.jobs.submit({
            // A job's id is its run operation's id, which the hub uses to
            // check who may read its log or kill it.
            job_id: id,
            operation_id: id,
            agent_id,
            source_project_id: ticket.source_project_id,
            name: op.request.name,
            description: op.request.description,
            command: op.request.command,
            cwd: resolveCwd(this.deps.workdir, op.request.cwd),
            nice: op.request.nice,
            exclusive: op.request.exclusive,
            auth: {
              computer_epoch: ticket.computer_epoch,
              policy_epoch: ticket.policy_epoch,
              privacy_epoch: ticket.attestation.payload.privacy_epoch,
              ...this.jobDeadline(
                Math.min(ticket.max_runtime_ms, remaining ?? Infinity),
              ),
            },
          });
          return done({ job_id: job.job_id, state: job.state });
        }
        case "exec": {
          // The output quota holds at admission too, not only hourly.
          this.pruneExecOutput();
          this.ledger.update(id, { state: "running" });
          const controller = new AbortController();
          this.running.set(id, { controller, agent_id });
          // The least of what was asked, what the ticket allows, and what is
          // left of the session.
          const timeout_ms = Math.max(
            1,
            Math.min(
              op.request.timeout_ms,
              ticket.max_runtime_ms,
              this.deps.session.remainingMs() ?? Infinity,
            ),
          );
          let r: ExecResult;
          try {
            r = await runExec(
              { ...op.request, timeout_ms },
              {
                workdir: this.deps.workdir,
                logDir: this.execDir(id),
                shell: this.deps.shell,
                killGraceMs: this.deps.killGraceMs,
                signal: controller.signal,
                // Recorded, so a later daemon can stop it if this one dies.
                // Without a readable identity it is never released.
                onSpawn: (pid) =>
                  this.ledger.update(id, {
                    result: {
                      pid,
                      pid_start: captureIdentity(pid, this.deps.identify),
                    },
                  }),
              },
            );
          } finally {
            this.running.delete(id);
          }
          const { stdout, stderr, ...summary } = r;
          const entry = this.ledger.update(id, {
            state: "done",
            exit_code: r.exit_code,
            result: summary,
          });
          this.report({ kind: "operation", entry });
          return {
            ok: true,
            operation_id: id,
            replayed,
            state: entry.state,
            result: { ...summary, stdout, stderr },
            error: null,
          };
        }
        case "put":
        case "get":
          throw new Error("file transfers are not available yet");
      }
    } catch (err) {
      const entry = this.ledger.update(id, {
        state: "failed",
        error: (err as Error).message,
      });
      this.report({ kind: "operation", entry });
      return {
        ok: true,
        operation_id: id,
        replayed,
        state: entry.state,
        result: null,
        error: entry.error,
      };
    }
  }

  private execDir(operation_id: string): string {
    return join(this.deps.stateDir, "exec", operation_id);
  }

  /** The bounded output of an exec, read back from the machine. */
  private execOutput(operation_id: string): { stdout: string; stderr: string } {
    let budget = MAX_EXEC_OUTPUT_BYTES;
    const read = (name: string) => {
      const path = join(this.execDir(operation_id), name);
      if (!existsSync(path) || budget <= 0) return "";
      const length = Math.min(statSync(path).size, budget);
      const buffer = Buffer.alloc(length);
      const fd = openSync(path, "r");
      try {
        readSync(fd, buffer, 0, length, 0);
      } finally {
        closeSync(fd);
      }
      budget -= length;
      return buffer.toString("utf8");
    };
    return { stdout: read("stdout"), stderr: read("stderr") };
  }

  /** One of the agent's operations, or its recent ones. */
  private ops(operation_id: string | null, agent_id: string): unknown {
    if (operation_id != null) {
      const entry = this.ledger.get(operation_id);
      if (entry == null || entry.agent_id !== agent_id) {
        return { operation: null };
      }
      return { operation: entry };
    }
    return {
      operations: this.ledger
        .list()
        .filter((e) => e.agent_id === agent_id)
        .slice(-50),
    };
  }

  private async info(): Promise<unknown> {
    let disk: { free_bytes: number; total_bytes: number } | null = null;
    try {
      const s = statfsSync(this.deps.workdir);
      disk = {
        free_bytes: s.bavail * s.bsize,
        total_bytes: s.blocks * s.bsize,
      };
    } catch {}
    return {
      hostname: hostname(),
      os: platform(),
      arch: arch(),
      cpus: cpus().length,
      cpu_model: cpus()[0]?.model ?? null,
      memory_bytes: totalmem(),
      free_memory_bytes: freemem(),
      load: loadavg(),
      disk,
      gpus: await gpus(),
      workdir: this.deps.workdir,
      mode: this.deps.store.effectivePolicy.mode,
      policy: this.deps.store.effectivePolicy,
      session_remaining_ms: this.deps.session.remainingMs(),
      daemon_version: this.deps.version ?? null,
    };
  }

  /**
   * Raise floors from a signed push.
   * - The computer epoch rose (revoked, or its network narrowed): queued
   *   work can't be re-authorized here, so it is cancelled; running jobs
   *   continue until the hub says more (revocation ends the session).
   * - A project's privacy epoch rose (it is no longer private): that
   *   project's queued jobs are cancelled and its running jobs stopped.
   */
  applyFloors(envelope: unknown): {
    raised: boolean;
    cancelled: string[];
    killed: string[];
  } {
    const hubNow = this.deps.hubClock.now();
    if (hubNow == null) throw new Error("no hub time yet");
    const before = this.deps.store.state.floors;
    const { raised } = this.deps.store.applyFloors(envelope, hubNow);
    const after = this.deps.store.state.floors;
    const cancelled: string[] = [];
    const killed: string[] = [];
    if (!raised) return { raised, cancelled, killed };
    const changedProjects = new Set(
      Object.keys(after.projects).filter(
        (p) => (after.projects[p] ?? 0) > (before.projects[p] ?? 0),
      ),
    );
    if (after.computer_epoch > before.computer_epoch) {
      cancelled.push(
        ...this.jobs.cancelQueued("authorization changed before it started"),
      );
    }
    if (changedProjects.size > 0) {
      const affected = (job: Job) => changedProjects.has(job.source_project_id);
      cancelled.push(
        ...this.jobs.cancelQueued(
          "its project is no longer eligible",
          affected,
        ),
      );
      killed.push(
        ...this.jobs.killWhere(affected, "its project is no longer eligible"),
      );
    }
    return { raised, cancelled, killed };
  }

  /** A job's deadline, on the wall clock and on this boot's clock. */
  private jobDeadline(ms: number): {
    deadline_at: number | null;
    boot_id: string | null;
    boot_deadline_ms: number | null;
  } {
    if (!Number.isFinite(ms)) {
      return { deadline_at: null, boot_id: null, boot_deadline_ms: null };
    }
    const boot = this.deps.bootClock ?? systemBootClock;
    const id = boot.bootId();
    const since = boot.sinceBootMs();
    return {
      deadline_at: this.deps.clocks.wall() + ms,
      boot_id: id != null && since != null ? id : null,
      boot_deadline_ms: id != null && since != null ? since + ms : null,
    };
  }

  /**
   * Enforce deadlines on a timer, whether or not anything arrives: the
   * session's end, jobs' limits and SIGTERM-to-SIGKILL escalation.
   */
  start(intervalMs = ENFORCEMENT_INTERVAL_MS): void {
    if (this.timer != null) return;
    let lastPrune = 0;
    this.timer = setInterval(() => {
      try {
        this.tick();
        const now = Date.now();
        if (now - lastPrune >= PRUNE_INTERVAL_MS) {
          lastPrune = now;
          this.prune(now);
        }
      } catch (err) {
        this.deps.onError?.(err);
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.timer != null) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Why a queued job may no longer start, or null. */
  private jobRefusal(job: Job): string | null {
    if (this.ended) return "the session on this computer has ended";
    const state = this.deps.store.state;
    if (job.auth.computer_epoch < state.floors.computer_epoch) {
      return "authorization changed before it started";
    }
    if (
      job.auth.privacy_epoch <
      (state.floors.projects[job.source_project_id] ?? 0)
    ) {
      return "its project is no longer eligible";
    }
    if (job.auth.policy_epoch !== state.policy_epoch) {
      return "the computer's policy changed before it started";
    }
    if (this.jobs.deadlinePassed(job, Date.now())) {
      return "its time limit passed while it was queued";
    }
    return null;
  }

  /**
   * Called on a timer and before each message: end the session at its
   * deadline, refresh jobs, and prune old records.
   */
  tick(now = Date.now()): void {
    if (!this.ended && this.deps.session.ended())
      this.endSession("time limit reached");
    this.jobs.refresh(now);
    this.cleanups.drive(now);
  }

  /** Tell the hub something; never let that change an operation's outcome. */
  private report(event: DaemonEvent): void {
    try {
      this.deps.report?.(event);
    } catch (err) {
      this.deps.onError?.(err);
    }
  }

  endSession(reason: string): void {
    this.ended = true;
    // The enforcement timer keeps running: killed jobs still need SIGKILL.
    for (const { controller } of this.running.values()) controller.abort();
    this.jobs.killAll(reason);
  }

  get sessionEnded(): boolean {
    return this.ended;
  }

  /**
   * Forget old records: ledger entries and their exec output after 7 days,
   * exec output beyond EXEC_OUTPUT_RETENTION_BYTES (oldest first), and old
   * jobs (see JobManager.prune).
   */
  prune(now = Date.now()): void {
    for (const id of this.ledger.pruneIds(LEDGER_RETENTION_MS, now)) {
      rmSync(this.execDir(id), { recursive: true, force: true });
    }
    this.pruneExecOutput();
    this.jobs.prune(now);
  }

  /** Keep all exec output under EXEC_OUTPUT_RETENTION_BYTES, oldest first. */
  private pruneExecOutput(): void {
    const root = join(this.deps.stateDir, "exec");
    if (existsSync(root)) {
      const dirs = readdirSync(root)
        .map((id) => {
          const path = join(root, id);
          let bytes = 0;
          let mtime = 0;
          try {
            for (const name of readdirSync(path)) {
              const st = statSync(join(path, name));
              bytes += st.size;
              mtime = Math.max(mtime, st.mtimeMs);
            }
          } catch {}
          return { id, path, bytes, mtime };
        })
        // Never the output of an exec still running.
        .filter((d) => !this.running.has(d.id))
        .sort((a, b) => a.mtime - b.mtime);
      let total = dirs.reduce((sum, d) => sum + d.bytes, 0);
      for (const d of dirs) {
        if (
          total <=
          (this.deps.execOutputQuotaBytes ?? EXEC_OUTPUT_RETENTION_BYTES)
        )
          break;
        rmSync(d.path, { recursive: true, force: true });
        total -= d.bytes;
      }
    }
  }
}

async function gpus(): Promise<unknown[]> {
  try {
    const { stdout } = await execFileAsync(
      "nvidia-smi",
      [
        "--query-gpu=name,memory.total,memory.used,utilization.gpu",
        "--format=csv,noheader,nounits",
      ],
      { timeout: 5000 },
    );
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, total, used, util] = line.split(",").map((s) => s.trim());
        return {
          name,
          memory_mb: Number(total),
          memory_used_mb: Number(used),
          utilization_percent: Number(util),
        };
      });
  } catch {
    return [];
  }
}
