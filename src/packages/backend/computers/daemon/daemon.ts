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
  readSync,
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
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  MAX_EXEC_OUTPUT_BYTES,
  type OperationRequest,
} from "@cocalc/util/computers/operations";
import type { ComputerTicket } from "@cocalc/util/computers/protocol";
import { admit, type AdmissionInput } from "./admission";
import type { Clocks, HubClock, SessionClock } from "./clock";
import { resolveCwd, runExec, type ExecResult } from "./exec";
import { JobManager, type Job, type JobSummary } from "./jobs";
import { Ledger, LedgerConflict, type LedgerEntry } from "./ledger";
import type { DaemonStore } from "./state";

const execFileAsync = promisify(execFile);

export const LEDGER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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
  version?: string;
}

export type DaemonEvent =
  | { kind: "operation"; entry: LedgerEntry }
  | { kind: "job"; job: Job };

const SIDE_EFFECTS = new Set(["exec", "run", "kill"]);

export class ComputerDaemon {
  readonly ledger: Ledger;
  readonly jobs: JobManager;
  private running = new Map<string, AbortController>();
  private ended = false;

  constructor(private readonly deps: DaemonDeps) {
    this.ledger = new Ledger(deps.stateDir);
    this.jobs = new JobManager(deps.stateDir, {
      shell: deps.shell,
      killGraceMs: deps.killGraceMs,
      onEnded: (job) => deps.report?.({ kind: "job", job }),
    });
    for (const operation_id of this.ledger.markInterrupted()) {
      const entry = this.ledger.get(operation_id);
      if (entry) deps.report?.({ kind: "operation", entry });
    }
    this.jobs.refresh();
  }

  /** One message from an agent: ticket, proof and request. */
  async handle(input: AdmissionInput): Promise<OperationReply> {
    this.tick();
    const admission = admit(input, {
      store: this.deps.store,
      hub_now: this.deps.hubClock.now(),
      continuous_now: this.deps.clocks.continuous(),
      session_ended: this.ended,
    });
    if (!admission.ok) return { ok: false, refused: admission.refusals };
    const { ticket, operation } = admission;

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
      result = {
        ...(entry.result as object),
        ...this.execOutput(entry.operation_id),
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
      this.deps.report?.({ kind: "operation", entry });
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
          const job = this.jobs.submit({
            job_id: randomUUID(),
            operation_id: id,
            agent_id,
            source_project_id: ticket.source_project_id,
            name: op.request.name,
            description: op.request.description,
            command: op.request.command,
            cwd: resolveCwd(this.deps.workdir, op.request.cwd),
            nice: op.request.nice,
            exclusive: op.request.exclusive,
          });
          return done({ job_id: job.job_id, state: job.state });
        }
        case "exec": {
          this.ledger.update(id, { state: "running" });
          const controller = new AbortController();
          this.running.set(id, controller);
          let r: ExecResult;
          try {
            r = await runExec(op.request, {
              workdir: this.deps.workdir,
              logDir: this.execDir(id),
              shell: this.deps.shell,
              killGraceMs: this.deps.killGraceMs,
              signal: controller.signal,
            });
          } finally {
            this.running.delete(id);
          }
          const { stdout, stderr, ...summary } = r;
          const entry = this.ledger.update(id, {
            state: "done",
            exit_code: r.exit_code,
            result: summary,
          });
          this.deps.report?.({ kind: "operation", entry });
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
      this.deps.report?.({ kind: "operation", entry });
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

  /** Raise floors from a signed push; queued work is cancelled if they rose. */
  applyFloors(envelope: unknown): { raised: boolean; cancelled: string[] } {
    const hubNow = this.deps.hubClock.now();
    if (hubNow == null) throw new Error("no hub time yet");
    const { raised } = this.deps.store.applyFloors(envelope, hubNow);
    const cancelled = raised
      ? this.jobs.cancelQueued("authorization changed before it started")
      : [];
    return { raised, cancelled };
  }

  /**
   * Called on a timer and before each message: end the session at its
   * deadline, refresh jobs, and prune old records.
   */
  tick(now = Date.now()): void {
    if (!this.ended && this.deps.session.ended())
      this.endSession("time limit reached");
    this.jobs.refresh(now);
  }

  endSession(reason: string): void {
    this.ended = true;
    for (const controller of this.running.values()) controller.abort();
    this.jobs.killAll(reason);
  }

  get sessionEnded(): boolean {
    return this.ended;
  }

  prune(now = Date.now()): void {
    this.ledger.prune(LEDGER_RETENTION_MS, now);
    this.jobs.prune(now);
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
