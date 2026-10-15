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
import type {
  ComputerEndReason,
  ComputerTicket,
} from "@cocalc/util/computers/protocol";
import {
  leaseHoursText,
  PRE_LEASE_TEXT,
  validLeaseHours,
} from "@cocalc/util/computers/policy";
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
/** How long an ended daemon keeps enforcing kills before it exits. */
export const DRAIN_MS = 30_000;
/** How often the timer forgets old records. */
export const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
/**
 * Finished exec output kept on the machine, together. Pruned (oldest first)
 * when an exec is admitted, when one finishes, and hourly. Output of execs
 * still running isn't counted (or pruned), so the disk used is at most this
 * plus, for each running exec, its two capped output files.
 */
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
  /**
   * Tests only: called at each crash point of applying state ("state-saved"
   * after the durable write, "side-effect" before each kill), so a test can
   * kill the process exactly there.
   */
  fault?: (point: "state-saved" | "side-effect") => void;
}

export type DaemonEvent =
  | { kind: "operation"; entry: LedgerEntry }
  | { kind: "job"; job: Job };

const SIDE_EFFECTS = new Set(["exec", "run", "kill"]);

const END_REASON_TEXT: Record<ComputerEndReason, string> = {
  revoked: "this computer was disconnected in CoCalc",
  deleted: "the CoCalc account of this computer was deleted",
  replaced: "this computer was connected again in CoCalc, as a new computer",
};

/** What authorized an exec: kept while it runs and in its ledger entry. */
export interface ExecAuth {
  source_project_id: string;
  computer_epoch: number;
  privacy_epoch: number;
  policy_epoch: number;
}

function execAuth(ticket: ComputerTicket): ExecAuth {
  return {
    source_project_id: ticket.source_project_id,
    computer_epoch: ticket.computer_epoch,
    privacy_epoch: ticket.attestation.payload.privacy_epoch,
    policy_epoch: ticket.policy_epoch,
  };
}

export class ComputerDaemon {
  readonly ledger: Ledger;
  readonly jobs: JobManager;
  readonly cleanups: Cleanups;
  private running = new Map<
    string,
    { controller: AbortController; agent_id: string; auth: ExecAuth }
  >();
  private ended = false;
  /** The hard lease lapsed and its work was stopped (until a renewal). */
  private lapsed = false;
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
    // Whatever the durable state says (ended, floors, policy) holds from
    // the first moment, before any reconnect or admission.
    this.reconcile();
  }

  /** One message from an agent: ticket, proof and request. */
  async handle(input: AdmissionInput): Promise<OperationReply> {
    if (!this.globalLimiter.allow("*", Date.now())) {
      return { ok: false, refused: ["this computer is busy; try again"] };
    }
    this.tick();
    if (!this.ended && this.leaseLapsed()) {
      return { ok: false, refused: [this.lapseText()] };
    }
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
        auth: execAuth(ticket),
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
            argv: op.request.argv,
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
          // The output quota holds at admission and completion, not only
          // hourly (see EXEC_OUTPUT_RETENTION_BYTES for the real bound).
          this.pruneExecOutput();
          this.ledger.update(id, { state: "running" });
          const controller = new AbortController();
          this.running.set(id, {
            controller,
            agent_id,
            auth: execAuth(ticket),
          });
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
                onSpawn: (child) =>
                  this.ledger.update(id, {
                    result: {
                      pid: child.pid,
                      pid_start: captureIdentity(child, this.deps.identify),
                    },
                  }),
              },
            );
          } finally {
            this.running.delete(id);
            // Its output counts now; the reply below carries it inline.
            this.pruneExecOutput();
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
   * A signed state snapshot from the home bay: applied durably in one
   * write, then every job and running exec is reconciled against the
   * result, whether or not anything changed. Only then is it acknowledged.
   * A policy that would widen is refused, but its floors and `ended` (which
   * only restrict) are applied and enforced anyway.
   */
  applyState(envelope: unknown): {
    state_version: string;
    envelope_hash: string;
  } {
    // Hub time when known; a daemon told it is ended at its login challenge
    // may not have it yet (the state only ever restricts).
    const hubNow = this.deps.hubClock.now() ?? this.deps.clocks.wall();
    let applied: ReturnType<DaemonStore["applyState"]>;
    try {
      applied = this.deps.store.applyState(envelope, hubNow, this.bootNow());
      this.deps.fault?.("state-saved");
    } finally {
      this.reconcile();
    }
    return {
      state_version: applied.state.state_version,
      envelope_hash: applied.envelope_hash,
    };
  }

  /**
   * Bring every queued job, running job and running exec in line with the
   * durable state. Idempotent: called after every state application (first
   * or replayed) and at every start, so a crash between a
   * state write and its side effects is always repaired.
   * - ended: the session ends for good and every job is killed (re-driven);
   * - below the computer floor: queued work is cancelled (running work
   *   continues, as documented);
   * - an older policy epoch: queued work is cancelled;
   * - below its project's floor: queued and running jobs and running execs
   *   are stopped. An exec's verified-pid cleanup is recorded durably before
   *   it is aborted.
   */
  reconcile(): { cancelled: string[]; killed: string[] } {
    const cancelled: string[] = [];
    const killed: string[] = [];
    const store = this.deps.store;
    const ended = store.ended;
    if (ended != null) {
      const reason = END_REASON_TEXT[ended.reason];
      if (!this.ended) this.endSession(reason);
      else this.jobs.killAll(reason);
      return { cancelled, killed };
    }
    if (this.leaseLapsed()) {
      this.stopForLapse();
      return { cancelled, killed };
    }
    this.lapsed = false;
    const { floors, policy_epoch } = store.state;
    const belowProject = (project_id: string, privacy_epoch: number) =>
      privacy_epoch < (floors.projects[project_id] ?? 0);
    cancelled.push(
      ...this.jobs.cancelQueued(
        "authorization changed before it started",
        (job: Job) => job.auth.computer_epoch < floors.computer_epoch,
      ),
      ...this.jobs.cancelQueued(
        "the computer's policy changed before it started",
        (job: Job) => job.auth.policy_epoch !== policy_epoch,
      ),
    );
    const ineligible = (job: Job) =>
      belowProject(job.source_project_id, job.auth.privacy_epoch);
    cancelled.push(
      ...this.jobs.cancelQueued(
        "its project is no longer eligible",
        ineligible,
      ),
    );
    this.deps.fault?.("side-effect");
    killed.push(
      ...this.jobs.killWhere(ineligible, "its project is no longer eligible"),
    );
    for (const [id, exec] of this.running) {
      if (!belowProject(exec.auth.source_project_id, exec.auth.privacy_epoch)) {
        continue;
      }
      this.deps.fault?.("side-effect");
      this.stopExec(id, exec.controller);
      killed.push(id);
    }
    return { cancelled, killed };
  }

  /** Record the exec's verified-pid cleanup durably, then abort it. */
  private stopExec(id: string, controller: AbortController): void {
    const r = this.ledger.get(id)?.result as {
      pid?: number;
      pid_start?: string;
    } | null;
    if (r?.pid != null && r.pid_start != null) {
      this.cleanups.add(id, r.pid, r.pid_start);
    }
    controller.abort();
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
    if (this.ended || this.deps.store.ended != null) {
      return "the session on this computer has ended";
    }
    if (this.leaseLapsed()) return this.lapseText();
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
    // Past its certificate this computer can never log in again (and its
    // revocation could no longer be signed): stop for good.
    if (
      !this.ended &&
      this.deps.store.certificate.payload.not_after <=
        (this.deps.hubClock.now() ?? this.deps.clocks.wall())
    ) {
      this.endSession("this computer's certificate expired");
    }
    // The hard lease, offline too: no contact for that long stops all work.
    if (!this.ended && !this.lapsed && this.leaseLapsed()) {
      this.stopForLapse();
    }
    this.jobs.refresh(now);
    this.cleanups.drive(now);
  }

  /**
   * Has the hard lease lapsed: no signed state from the home bay for
   * lease_hours, by the (hub) wall clock or, on the same boot, by the time
   * since boot (so moving the wall clock back doesn't stretch it)?
   */
  leaseLapsed(): boolean {
    const hours = this.deps.store.effectivePolicy.lease_hours;
    // Paired before the hard lease (no or a bad lease): fail closed.
    if (!validLeaseHours(hours)) return true;
    const leaseMs = hours * 3600_000;
    const renewal = this.deps.store.renewal;
    const now = this.deps.hubClock.now() ?? this.deps.clocks.wall();
    if (now - renewal.at > leaseMs) return true;
    const boot = this.deps.bootClock ?? systemBootClock;
    if (renewal.boot != null && boot.bootId() === renewal.boot.boot_id) {
      const since = boot.sinceBootMs();
      if (since != null && since - renewal.boot.since_boot_ms > leaseMs) {
        return true;
      }
    }
    return false;
  }

  /** Stop every exec and job: the hard lease lapsed (not an end). */
  private stopForLapse(): void {
    this.lapsed = true;
    const reason = this.lapseText();
    for (const [id, { controller }] of this.running) {
      this.deps.fault?.("side-effect");
      this.stopExec(id, controller);
    }
    this.deps.fault?.("side-effect");
    this.jobs.killAll(reason);
  }

  private lapseText(): string {
    if (!validLeaseHours(this.deps.store.effectivePolicy.lease_hours)) {
      return PRE_LEASE_TEXT;
    }
    return `this computer could not connect to CoCalc for ${leaseHoursText(
      this.deps.store.effectivePolicy.lease_hours,
    )}, so its jobs stopped; it runs work again once it reconnects`;
  }

  private bootNow(): { boot_id: string; since_boot_ms: number } | null {
    const boot = this.deps.bootClock ?? systemBootClock;
    const boot_id = boot.bootId();
    const since_boot_ms = boot.sinceBootMs();
    return boot_id != null && since_boot_ms != null
      ? { boot_id, since_boot_ms }
      : null;
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
    for (const [id, { controller }] of this.running) {
      this.deps.fault?.("side-effect");
      this.stopExec(id, controller);
    }
    this.deps.fault?.("side-effect");
    this.jobs.killAll(reason);
  }

  /**
   * After the session ended: keep enforcing until every killed job is gone
   * and every exec cleanup is done (SIGKILL follows SIGTERM after the grace
   * period), or until maxMs. Whatever is left is re-driven at the next start.
   */
  async drain(maxMs = DRAIN_MS, pollMs = 250): Promise<boolean> {
    const until = Date.now() + maxMs;
    for (;;) {
      this.tick();
      if (
        this.running.size === 0 &&
        this.jobs.liveCount() === 0 &&
        this.cleanups.pending().length === 0
      ) {
        return true;
      }
      if (Date.now() >= until) return false;
      await new Promise((r) => setTimeout(r, pollMs));
    }
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
