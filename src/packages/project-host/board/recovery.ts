/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The board recovery runner (isolation plan, r7): runs one reconstruct job in
the isolated child, under a launcher that creates the job's cgroup leaf and
starts the child in it as the recovery user, and turns whatever happens into
exactly one terminal state:

  complete        a valid result for this job and its exact input, and the
                  child exited 0 with its leaf removed;
  refused         the launcher denied the job (busy, unavailable, an
                  isolation it couldn't verify), or this runner is busy, or
                  the child's hello didn't verify; nothing was sent;
  timeout         the setup deadline (no verified hello), the CPU budget or
                  the wall deadline ended it;
  oom             the leaf's oom_kill counter advanced (only that);
  crash           any other exit (non-zero, a signal, a V8 heap abort);
  protocol-error  a bad frame: over its cap, not one value, failing its
                  schema, the wrong job id or input hash, or bytes after the
                  result.

Precedence: oom, then timeout, then protocol-error, then crash. A helper
denial is refused only if it came before the setup deadline.

The runner never signals a process itself: every kill and every cleanup is
the launcher's stop (a cgroup.kill of the job's leaf), given the time left in
the job's terminal-report envelope (91 s from the launch request). A job's
slot is released only after stop reports the leaf removed (or the launch
cancelled before it reserved one) and the launcher process exited; if that
can't be confirmed in time, the job still reports its terminal state, and
its slot stays held (fail closed).

Nothing here publishes: the caller rechecks its stream's generation when the
result is delivered.

The launcher is injected: production's runs the root wrapper through sudo
(not in this module), and tests run a fake one over a temporary cgroup tree.
*/

import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  FrameReader,
  ProtocolError,
  decodeFrameBody,
  jobFrameChunks,
  type FrameKind,
  type HelloFrame,
  type JobRecord,
  type ResultFrame,
  type Verdict,
} from "@cocalc/conat/board-recovery/frame";

export type TerminalState =
  | "complete"
  | "refused"
  | "timeout"
  | "oom"
  | "crash"
  | "protocol-error";

// What stop-board-recovery reports: the leaf's counters, read before it was
// removed.
export interface StopReport {
  // removed: the leaf is gone (and its record tombstoned); cancelled: the
  // launch hadn't reserved a leaf, and now never will; busy: the leaf
  // wasn't empty in time; failed: the stop didn't complete (nothing is
  // confirmed).
  state: "removed" | "cancelled" | "busy" | "failed";
  oom_kill?: number;
  memory_peak?: number;
  usage_usec?: number;
  pids_peak?: number;
  message?: string;
}

export interface RecoveryLauncher {
  // Start the job's launch (production: sudo -n the wrapper's
  // run-board-recovery <job-id> <instance-id>), with stdin, stdout and
  // stderr as pipes. A denial is exit code DENIED_EXIT with "denied:
  // <reason>" on stderr, before any hello.
  spawn(jobId: string): ChildProcess;
  // stop-board-recovery <job-id> <instance-id> <budget-ms>.
  stop(jobId: string, budgetMs: number): Promise<StopReport>;
  // The leaf's cpu.stat usage_usec, or undefined if there is no leaf yet.
  cpuUsageUsec(jobId: string): Promise<number | undefined>;
}

export const DENIED_EXIT = 3;

const HASH_SLICE = 1024 * 1024;
// Of a stop's parent-side wait, what is left for its answer to arrive.
const STOP_TRANSPORT_MS = 250;
const YIELD_BYTES = 2 * 1024 * 1024;
const YIELD_CHUNKS = 1000;

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

export interface RecoveryIdentity {
  // cocalc-board-recovery's, resolved once when the capability is probed.
  uid: number;
  gid: number;
  // The recovery pool's cgroup path (from the trusted launcher's
  // configuration): a job's leaf must be exactly <pool>/job-<job id>.
  pool: string;
  // The leaf's memory.max, as it must read back.
  memoryMax: string;
}

export interface RecoveryLimits {
  setupMs: number;
  cpuUsec: number;
  wallMs: number;
  // The terminal-report envelope beyond the wall deadline: the first stop's
  // minimum budget.
  firstStopMinMs: number;
  stopWaitMs: number;
  stopRetries: number;
  stopRetryGapMs: number;
  cpuPollMs: number;
  stderrBytes: number;
  maxActive: number;
  maxQueue: number;
}

export const RECOVERY_LIMITS: RecoveryLimits = {
  setupMs: 10_000,
  cpuUsec: 30_000_000,
  wallMs: 90_000,
  firstStopMinMs: 1_000,
  stopWaitMs: 5_000,
  stopRetries: 3,
  stopRetryGapMs: 1_000,
  cpuPollMs: 250,
  stderrBytes: 64 * 1024,
  maxActive: 2,
  maxQueue: 8,
};

export type RecoveryOutcome =
  | {
      state: "complete";
      jobId: string;
      inputSha256: string;
      verdict: Verdict;
      value: string | null;
      identifiers: string[];
      report: StopReport;
    }
  | {
      state: Exclude<TerminalState, "complete">;
      jobId?: string;
      reason: string;
      report?: StopReport;
      // The slot couldn't be released (cleanup unconfirmed).
      held?: boolean;
    };

// Only these fd targets, besides 0, 1 and 2, may be open in the child: Node's
// own runtime fds (libuv's epoll and eventfd, internal pipes, and the
// /dev/null it holds in reserve for when fds run out; a bare Node 26 has
// fds 3 to 17 of these). Inheritance of anything else is the launcher's
// guarantee; this is defense in depth. Devices are allowed by exact path
// only.
const RUNTIME_FD = /^(anon_inode:|pipe:)/;
const RUNTIME_DEVICES = new Set(["/dev/null"]);

export function verifyHello(
  hello: HelloFrame,
  jobId: string,
  identity: RecoveryIdentity,
): string | undefined {
  if (hello.job_id !== jobId) return "a hello for another job";
  if (hello.uid !== identity.uid || hello.gid !== identity.gid) {
    return `the child runs as ${hello.uid}:${hello.gid}, not the recovery user`;
  }
  if (hello.groups.length > 0) return "the child has supplementary groups";
  if (hello.no_new_privs !== 1) return "the child may gain privileges";
  if (hello.cap_eff !== "0" || hello.cap_prm !== "0") {
    return "the child has capabilities";
  }
  for (const { fd, target } of hello.fds) {
    if (fd <= 2) continue;
    if (!RUNTIME_FD.test(target) && !RUNTIME_DEVICES.has(target)) {
      return `the child has fd ${fd} open on ${target}`;
    }
  }
  // The whole path, exactly (astra CORR-DFC-5): the right leaf name under
  // another pool, a prefix, ".." or a trailing slash is not the job's leaf.
  if (hello.cgroup !== `${identity.pool}/job-${jobId}`) {
    return `the child is in ${hello.cgroup}, not its job's leaf`;
  }
  if (hello.limits.memory_max !== identity.memoryMax) {
    return `its leaf's memory.max is ${hello.limits.memory_max}`;
  }
  if (hello.limits.swap_max !== "0") return "its leaf may swap";
  return undefined;
}

export class RecoveryRunner {
  private readonly launcher: RecoveryLauncher;
  private readonly identity: RecoveryIdentity;
  private readonly limits: RecoveryLimits;
  private readonly now: () => number;
  private active = 0;
  // Slots whose cleanup was never confirmed: never released.
  private held = 0;
  private readonly waiting: (() => void)[] = [];

  constructor({
    launcher,
    identity,
    limits,
    now = () => performance.now(),
  }: {
    launcher: RecoveryLauncher;
    identity: RecoveryIdentity;
    limits?: Partial<RecoveryLimits>;
    now?: () => number;
  }) {
    this.launcher = launcher;
    this.identity = identity;
    this.limits = { ...RECOVERY_LIMITS, ...limits };
    this.now = now;
  }

  // For tests and telemetry.
  get counts() {
    return {
      active: this.active,
      held: this.held,
      waiting: this.waiting.length,
    };
  }

  // load reads the job's history: called only once a slot is reserved, so a
  // queued job holds no history (astra, for daybreak2: the queue holds
  // references, not up to 8 maximal histories).
  //
  // CALLERS: pass a function that READS the history when called, e.g.
  // `() => readBoardHistory(stream)`. Never a closure over records already
  // read (`const records = await read(); run(() => records)`): the queue
  // would hold them all the same, whether or not load is ever called.
  async run(
    load: () => JobRecord[] | Promise<JobRecord[]>,
  ): Promise<RecoveryOutcome> {
    if (this.active + this.held >= this.limits.maxActive) {
      if (this.waiting.length >= this.limits.maxQueue) {
        return { state: "refused", reason: "busy" };
      }
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    let held = false;
    try {
      let records: JobRecord[];
      try {
        records = await load();
      } catch (err) {
        return {
          state: "refused",
          reason: `the history couldn't be read: ${err}`.slice(0, 300),
        };
      }
      const outcome = await new Job(
        this.launcher,
        this.identity,
        this.limits,
        this.now,
        records,
      ).run();
      held = outcome.state !== "complete" && outcome.held === true;
      return outcome;
    } finally {
      this.active -= 1;
      if (held) {
        this.held += 1;
      } else {
        this.waiting.shift()?.();
      }
    }
  }
}

class Job {
  private readonly jobId = randomBytes(16).toString("hex");
  private readonly start: number;
  private proc?: ChildProcess;
  private exited?: { code: number | null; signal: NodeJS.Signals | null };
  private exitWaiters: (() => void)[] = [];
  private stderr = "";
  private hello?: HelloFrame;
  private result?: ResultFrame;
  private inputSha256?: string;
  // Every cause the runner saw for ending the job, the first reason of each
  // kind: classify() applies the declared precedence to all of them, never
  // just the first to arrive (astra CORR-DFC-4).
  private causes: Partial<
    Record<"timeout" | "protocol-error" | "refused", string>
  > = {};
  private exitAt?: number;
  private stdoutEnded = false;
  private stdoutWaiters: (() => void)[] = [];
  private reader?: FrameReader;
  private settle?: () => void;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly launcher: RecoveryLauncher,
    private readonly identity: RecoveryIdentity,
    private readonly limits: RecoveryLimits,
    private readonly now: () => number,
    private readonly records: JobRecord[],
  ) {
    // The deadlines start here, at the launch request, before the spawn.
    this.start = now();
  }

  private remainingMs(): number {
    return (
      this.start + this.limits.wallMs + this.limits.firstStopMinMs - this.now()
    );
  }

  private end(state: "timeout" | "protocol-error" | "refused", reason: string) {
    this.causes[state] ??= reason;
    this.settle?.();
  }

  private get ending(): boolean {
    return Object.keys(this.causes).length > 0;
  }

  async run(): Promise<RecoveryOutcome> {
    try {
      this.proc = this.launcher.spawn(this.jobId);
    } catch (err) {
      return { state: "refused", jobId: this.jobId, reason: `${err}` };
    }
    const proc = this.proc;
    const finished = new Promise<void>((resolve) => (this.settle = resolve));
    proc.on("exit", (code, signal) => {
      this.exitAt = this.now();
      this.exited = { code, signal };
      for (const f of this.exitWaiters.splice(0)) f();
      this.settle?.();
    });
    proc.on("error", (err) => this.end("refused", `the launcher: ${err}`));
    proc.stderr?.on("data", (chunk: Buffer) => {
      if (this.stderr.length < this.limits.stderrBytes) {
        this.stderr += chunk
          .toString("utf8")
          .slice(0, this.limits.stderrBytes - this.stderr.length);
      }
    });
    proc.stdin?.on("error", () => {}); // a closed pipe ends the job by exit
    const reader = new FrameReader(["hello", "result"], (kind, body) =>
      this.onFrame(kind, body),
    );
    this.reader = reader;
    // Read until the output ends, even after the result and the exit: a
    // byte after the result is a protocol error until then.
    proc.stdout?.on("data", (chunk: Buffer) => {
      reader.push(chunk);
      if (reader.error) {
        this.end("protocol-error", reader.error.message);
      }
    });
    const ended = () => {
      this.stdoutEnded = true;
      for (const f of this.stdoutWaiters.splice(0)) f();
    };
    proc.stdout?.on("end", ended);
    proc.stdout?.on("close", ended);
    this.timers.push(
      setTimeout(() => {
        if (this.hello == null) this.end("timeout", "setup");
      }, this.limits.setupMs),
      setTimeout(() => this.end("timeout", "wall"), this.limits.wallMs),
    );
    const poll = setInterval(async () => {
      if (this.hello == null || this.ending || this.exited != null) return;
      try {
        const usage = await this.launcher.cpuUsageUsec(this.jobId);
        if (usage != null && usage > this.limits.cpuUsec)
          this.end("timeout", "cpu");
      } catch {}
    }, this.limits.cpuPollMs);
    this.timers.push(poll as unknown as NodeJS.Timeout);

    await finished;
    // An exit is not the end of the output (a descendant may hold the pipe):
    // wait for it, within the envelope, before anything is classified.
    if (!this.ending) await this.waitStdoutEnd(this.remainingMs());
    for (const t of this.timers) clearTimeout(t);
    clearInterval(poll);
    proc.stdin?.destroy();

    // Cleanup, on every path: stop (the leaf's cgroup.kill, its report,
    // its removal), then the launcher's exit, within the envelope.
    const { report, confirmed } = await this.cleanup();
    return this.classify(report, confirmed);
  }

  private onFrame(kind: FrameKind, body: Uint8Array): void {
    if (this.ending) return;
    if (kind === "hello") {
      const hello = decodeFrameBody("hello", body);
      const wrong = verifyHello(hello, this.jobId, this.identity);
      if (wrong != null) {
        this.end("refused", `isolation-unverified: ${wrong}`);
        return;
      }
      if (this.now() - this.start > this.limits.setupMs) {
        this.end("timeout", "setup");
        return;
      }
      this.hello = hello;
      // Only now, isolation verified, is the history sent.
      void this.sendJob().catch((err) =>
        this.end("protocol-error", `sending the job: ${err}`),
      );
      return;
    }
    const result = decodeFrameBody("result", body);
    if (result.job_id !== this.jobId) {
      throw new ProtocolError("a result for another job");
    }
    if (result.input_sha256 !== this.inputSha256) {
      throw new ProtocolError("a result for another input");
    }
    this.result = result;
  }

  /*
  The job frame, written a chunk at a time (jobFrameChunks: the records'
  bytes as they are), hashed in slices, with a yield to the event loop every
  YIELD_BYTES and the pipe's backpressure respected: a 64 MiB job never
  holds the host's event loop for long. The input hash is complete before
  the last chunk is written, so it is always there before any result.
  */
  private async sendJob(): Promise<void> {
    const stdin = this.proc!.stdin!;
    const chunks = jobFrameChunks({
      v: 1,
      type: "job",
      job_id: this.jobId,
      kind: "reconstruct",
      records: this.records,
    });
    const hash = createHash("sha256");
    let sinceYield = 0;
    let chunksSinceYield = 0;
    let first = true;
    let current = chunks.next();
    while (!current.done) {
      if (this.ending || this.exited != null) return;
      const chunk = current.value;
      // (The first chunk is the length header, not part of the body.)
      if (!first) {
        for (let at = 0; at < chunk.byteLength; at += HASH_SLICE) {
          hash.update(chunk.subarray(at, at + HASH_SLICE));
          sinceYield += Math.min(HASH_SLICE, chunk.byteLength - at);
          if (sinceYield >= YIELD_BYTES) {
            sinceYield = 0;
            await yieldToLoop();
            if (this.ending || this.exited != null) return;
          }
        }
      }
      first = false;
      const next = chunks.next();
      if (next.done) this.inputSha256 = hash.digest("hex");
      const flowing = stdin.write(chunk);
      chunksSinceYield += 1;
      if (!flowing) {
        await new Promise<void>((resolve) => {
          const done = () => {
            stdin.off("drain", done);
            stdin.off("close", done);
            resolve();
          };
          stdin.on("drain", done);
          stdin.on("close", done);
        });
        chunksSinceYield = 0;
      } else if (chunksSinceYield >= YIELD_CHUNKS) {
        chunksSinceYield = 0;
        await yieldToLoop();
      }
      current = next;
    }
    stdin.end();
  }

  private waitExit(ms: number): Promise<boolean> {
    if (this.exited != null) return Promise.resolve(true);
    if (ms <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      this.exitWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private waitStdoutEnd(ms: number): Promise<boolean> {
    if (this.stdoutEnded) return Promise.resolve(true);
    if (ms <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      this.stdoutWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  // One stop, bounded HERE as well as by the budget it is given (astra
  // CORR-DFC-3): a helper that never answers, or answers late, is "failed",
  // and its late answer changes nothing (the slot stays held).
  private async stopOnce(budgetMs: number): Promise<StopReport> {
    const budget = Math.round(budgetMs);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<StopReport>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({ state: "failed", message: "stop didn't answer in time" }),
        budget,
      );
    });
    try {
      return await Promise.race([
        this.launcher
          .stop(this.jobId, Math.max(500, budget - STOP_TRANSPORT_MS))
          .catch((err): StopReport => ({ state: "failed", message: `${err}` })),
        late,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async cleanup(): Promise<{ report: StopReport; confirmed: boolean }> {
    const { stopWaitMs, stopRetryGapMs, stopRetries, firstStopMinMs } =
      this.limits;
    // The first stop always runs, with at least firstStopMinMs.
    let report = await this.stopOnce(
      Math.min(30_000, Math.max(firstStopMinMs, this.remainingMs())),
    );
    // Retries only while a full wait and its gap fit.
    for (
      let i = 0;
      i < stopRetries &&
      report.state !== "removed" &&
      report.state !== "cancelled" &&
      this.remainingMs() >= stopWaitMs + stopRetryGapMs;
      i++
    ) {
      await new Promise((r) => setTimeout(r, stopRetryGapMs));
      report = await this.stopOnce(Math.min(30_000, this.remainingMs()));
    }
    let exited = await this.waitExit(this.remainingMs());
    if (!exited && this.remainingMs() >= firstStopMinMs) {
      // The launcher outlived its leaf's kill (still before its leaf, say):
      // stop again, which cancels it, then wait once more.
      const again = await this.stopOnce(Math.min(30_000, this.remainingMs()));
      if (again.state === "removed" || again.state === "cancelled")
        report = again;
      exited = await this.waitExit(this.remainingMs());
    }
    const confirmed =
      exited && (report.state === "removed" || report.state === "cancelled");
    return { report, confirmed };
  }

  /*
  The declared precedence, over every cause seen and when it arrived:
  oom; then timeout (the runner's setup, CPU or wall deadline, or a denial
  that arrived after the setup deadline); then protocol-error; then refused
  (a timely denial, or a hello that didn't verify); then crash; complete
  only with a valid result, a clean output end, exit 0 and confirmed
  cleanup.
  */
  private classify(report: StopReport, confirmed: boolean): RecoveryOutcome {
    const base = { jobId: this.jobId, report, held: !confirmed };
    if ((report.oom_kill ?? 0) > 0) {
      return { state: "oom", reason: "oom_kill", ...base };
    }
    // A denial: the launcher's exit before any hello.
    const denied =
      this.hello == null &&
      this.exited?.code === DENIED_EXIT &&
      /^denied: /.test(this.stderr);
    const deniedLate =
      denied &&
      this.exitAt != null &&
      this.exitAt - this.start > this.limits.setupMs;
    const timeout = this.causes.timeout ?? (deniedLate ? "setup" : undefined);
    if (timeout != null) {
      return { state: "timeout", reason: timeout, ...base };
    }
    if (this.causes["protocol-error"] != null) {
      return {
        state: "protocol-error",
        reason: this.causes["protocol-error"],
        ...base,
      };
    }
    if (denied) {
      return {
        state: "refused",
        reason: this.stderr.split("\n")[0].slice(8, 300),
        ...base,
      };
    }
    if (this.causes.refused != null) {
      return { state: "refused", reason: this.causes.refused, ...base };
    }
    const exit = this.exited;
    if (exit == null || exit.code !== 0 || exit.signal != null) {
      return {
        state: "crash",
        reason:
          exit == null
            ? "the launcher didn't exit"
            : `exit ${exit.code ?? exit.signal}: ${this.stderr.slice(0, 300)}`,
        ...base,
      };
    }
    // Protocol completion: the output ended, cleanly, after exactly the
    // frames expected (astra CORR-DFC-2).
    if (!this.stdoutEnded) {
      return {
        state: "protocol-error",
        reason: "the child's output didn't end",
        ...base,
      };
    }
    if (!this.reader?.done || !this.reader.atBoundary) {
      return {
        state: "protocol-error",
        reason: "the output ended inside a frame, or before the result",
        ...base,
      };
    }
    if (this.result == null) {
      return { state: "protocol-error", reason: "no result", ...base };
    }
    if (!confirmed) {
      // A result, but the job's end isn't confirmed: never a recovery.
      return { state: "crash", reason: "cleanup unconfirmed", ...base };
    }
    return {
      state: "complete",
      jobId: this.jobId,
      inputSha256: this.inputSha256!,
      verdict: this.result.verdict,
      value: this.result.value,
      identifiers: this.result.identifiers,
      report,
    };
  }
}
