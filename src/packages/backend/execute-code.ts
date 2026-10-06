/*
 *  This file is part of CoCalc: Copyright © 2020–2024 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Execute code in a subprocess.

import { callback, delay } from "awaiting";
import LRU from "lru-cache";
import {
  ChildProcessWithoutNullStreams,
  spawn,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { exitCode } from "@cocalc/backend/sandbox/exec";
import { join } from "node:path";
import { EventEmitter } from "node:stream";
import shellEscape from "shell-escape";
import getLogger from "@cocalc/backend/logger";
import { envToInt } from "@cocalc/backend/misc/env-to-number";
import { aggregate } from "@cocalc/util/aggregate";
import { callback_opts } from "@cocalc/util/async-utils";
import { PROJECT_EXEC_DEFAULT_TIMEOUT_S } from "@cocalc/util/consts/project";
import {
  to_json,
  trunc,
  trunc_middle,
  uuid,
  walltime,
} from "@cocalc/util/misc";
import { projectRuntimePathForProcess } from "@cocalc/util/project-runtime";
import {
  isExecuteCodeOptionsAsyncCancel,
  isExecuteCodeOptionsAsyncGet,
  type ExecuteCodeAggregate,
  type ExecuteCodeFunctionWithCallback,
  type ExecuteCodeJobGroupEvent,
  type ExecuteCodeJobGroupSnapshot,
  type ExecuteCodeOptions,
  type ExecuteCodeOptionsWithCallback,
  type ExecuteCodeOutput,
  type ExecuteCodeOutputAsync,
  type ExecuteCodeOutputBlocking,
  type ExecuteCodeRequest,
  type ExecuteCodeStreamEvent,
} from "@cocalc/util/types/execute-code";
import type { Processes } from "@cocalc/util/types/project-info/types";
import { envForSpawn } from "./misc";
import { trackProcessRoot } from "./process-tracker";
import { ProcessStats, sumChildren } from "./process-stats";

const log = getLogger("execute-code");
const SECURITY_DENY_PREFIX = "SECURITY_DENY";

const PREFIX = "COCALC_PROJECT_ASYNC_EXEC";
const ASYNC_CACHE_MAX = envToInt(`${PREFIX}_CACHE_MAX`, 100);
const ASYNC_CACHE_TTL_S = envToInt(`${PREFIX}_TTL_S`, 60 * 60);
const KEYED_DONE_CACHE_TTL_S = envToInt(`${PREFIX}_KEYED_DONE_TTL_S`, 60);
// for async execution, every that many secs check up on the child-tree
let MONITOR_INTERVAL_S = envToInt(`${PREFIX}_MONITOR_INTERVAL_S`, 60);

export function setMonitorIntervalSeconds(n) {
  MONITOR_INTERVAL_S = n;
}

const MONITOR_STATS_LENGTH_MAX = envToInt(
  `${PREFIX}_MONITOR_STATS_LENGTH_MAX`,
  100,
);

log.debug("configuration:", {
  ASYNC_CACHE_MAX,
  ASYNC_CACHE_TTL_S,
  KEYED_DONE_CACHE_TTL_S,
  MONITOR_INTERVAL_S,
  MONITOR_STATS_LENGTH_MAX,
});

type AsyncAwait = "finished" | "stream";
const updates = new EventEmitter();
const jobGroupUpdates = new EventEmitter();
const eventKey = (type: AsyncAwait, job_id: string): string =>
  `${type}-${job_id}`;
const JOB_GROUP_EVENT = "event";

interface ActiveKeyedJob {
  aggregate?: ExecuteCodeAggregate;
  fingerprint: string;
  job_id: string;
  started?: Promise<ExecuteCodeOutputAsync>;
}

interface CompletedKeyedJob {
  aggregate?: ExecuteCodeAggregate;
  fingerprint: string;
  job_id: string;
}

interface PendingKeyedJob {
  aggregate?: ExecuteCodeAggregate;
  fingerprint: string;
  opts: ExecuteCodeOptions;
  promise: Promise<ExecuteCodeOutputAsync>;
  resolve: (output: ExecuteCodeOutputAsync) => void;
  reject: (err: unknown) => void;
}

const activeAsyncOutputs = new Map<string, ExecuteCodeOutputAsync>();
const cancelledAsyncJobs = new Set<string>();
const activeKeyedJobs = new Map<string, ActiveKeyedJob>();
const pendingKeyedJobs = new Map<string, PendingKeyedJob>();
const completedKeyedJobs = new LRU<string, CompletedKeyedJob>({
  max: ASYNC_CACHE_MAX,
  // Match aggregate()'s short completed-result cache. The async result itself
  // remains available by job_id for ASYNC_CACHE_TTL_S.
  ttl: 1000 * KEYED_DONE_CACHE_TTL_S,
});
const jobGroupSequences = new Map<string, number>();

export const asyncCache = new LRU<string, ExecuteCodeOutputAsync>({
  max: ASYNC_CACHE_MAX,
  ttl: 1000 * ASYNC_CACHE_TTL_S,
  updateAgeOnGet: true,
  updateAgeOnHas: true,
});

function cloneAsyncOutput(
  output: ExecuteCodeOutputAsync,
): ExecuteCodeOutputAsync {
  return {
    ...output,
    stats: output.stats == null ? undefined : [...output.stats],
  };
}

export function getAsyncJob(
  job_id: string,
): ExecuteCodeOutputAsync | undefined {
  const output = activeAsyncOutputs.get(job_id) ?? asyncCache.get(job_id);
  return output == null ? undefined : cloneAsyncOutput(output);
}

export function attachToAsyncJob(
  job_id: string,
  listener: (event: ExecuteCodeStreamEvent) => void,
): {
  output: ExecuteCodeOutputAsync;
  unsubscribe: () => void;
} {
  const key = eventKey("stream", job_id);
  updates.on(key, listener);
  const output = getAsyncJob(job_id);
  if (output == null) {
    updates.off(key, listener);
    throw new Error(`Async operation '${job_id}' does not exist.`);
  }
  const unsubscribe = () => updates.off(key, listener);
  if (output.status !== "running") {
    unsubscribe();
  }
  return { output, unsubscribe };
}

export function getAsyncJobGroupSnapshot(
  job_group: string,
): ExecuteCodeJobGroupSnapshot[] {
  const snapshots: ExecuteCodeJobGroupSnapshot[] = [];
  for (const output of activeAsyncOutputs.values()) {
    if (output.job_group !== job_group) continue;
    snapshots.push({
      output: cloneAsyncOutput(output),
      seq: jobGroupSequences.get(output.job_id) ?? 0,
    });
  }
  return snapshots;
}

export function onAsyncJobGroupEvent(
  listener: (event: ExecuteCodeJobGroupEvent) => void,
): () => void {
  jobGroupUpdates.on(JOB_GROUP_EVENT, listener);
  return () => jobGroupUpdates.off(JOB_GROUP_EVENT, listener);
}

function emitAsyncJobGroupEvent(
  opts: Pick<ExecuteCodeOptions, "job_group" | "job_key"> & {
    job_id?: string;
  },
  event: {
    type: "job" | "done";
    data: ExecuteCodeOutputAsync;
  },
) {
  if (!opts.job_id) return;
  const output = getAsyncJob(opts.job_id);
  const job_group = opts.job_group ?? output?.job_group;
  if (!job_group) return;
  const seq = (jobGroupSequences.get(opts.job_id) ?? 0) + 1;
  jobGroupSequences.set(opts.job_id, seq);
  const update: ExecuteCodeJobGroupEvent = {
    aggregate: output?.aggregate,
    data: event.data,
    job_group,
    job_id: opts.job_id,
    job_key: opts.job_key ?? output?.job_key,
    seq,
    type: event.type,
  };
  for (const listener of jobGroupUpdates.listeners(JOB_GROUP_EVENT)) {
    try {
      (listener as (event: ExecuteCodeJobGroupEvent) => void)(update);
    } catch (err) {
      log.warn("async job group observer failed", { err: `${err}` });
    }
  }
  if (event.type === "done") {
    jobGroupSequences.delete(opts.job_id);
  }
}

function emitAsyncStreamEvent(
  opts: Pick<
    ExecuteCodeOptions,
    "async_call" | "job_group" | "job_key" | "streamCB"
  > & {
    job_id?: string;
  },
  event: ExecuteCodeStreamEvent,
) {
  if (
    event.type === "done" &&
    opts.job_id &&
    cancelledAsyncJobs.has(opts.job_id) &&
    event.data != null &&
    typeof event.data === "object"
  ) {
    event = {
      ...event,
      data: {
        ...(event.data as ExecuteCodeOutputAsync),
        status: "killed",
      },
    };
  }
  opts.streamCB?.(event);
  if (opts.async_call && opts.job_id) {
    updates.emit(eventKey("stream", opts.job_id), event);
  }
  if (event.type === "done") {
    emitAsyncJobGroupEvent(opts, {
      type: "done",
      data: event.data as ExecuteCodeOutputAsync,
    });
  }
}

function setAsyncOutput(output: ExecuteCodeOutputAsync) {
  if (output.status === "running") {
    activeAsyncOutputs.set(output.job_id, output);
    asyncCache.delete(output.job_id);
  } else {
    activeAsyncOutputs.delete(output.job_id);
    asyncCache.set(output.job_id, output);
  }
}

function truncStats(obj?: ExecuteCodeOutputAsync) {
  if (Array.isArray(obj?.stats)) {
    // truncate to $MONITOR_STATS_LENGTH_MAX, by discarding the inital entries
    obj.stats = obj.stats.slice(obj.stats.length - MONITOR_STATS_LENGTH_MAX);
  }
}

function asyncCacheUpdate(job_id: string, upd): ExecuteCodeOutputAsync {
  const obj = activeAsyncOutputs.get(job_id) ?? asyncCache.get(job_id);
  if (Array.isArray(obj?.stats) && Array.isArray(upd.stats)) {
    obj.stats.push(...upd.stats);
    truncStats(obj);
  }
  const next: ExecuteCodeOutputAsync = {
    ...obj,
    ...upd,
    ...(cancelledAsyncJobs.has(job_id) && upd.status !== "running"
      ? { status: "killed", exit_code: upd.exit_code || 1 }
      : undefined),
  };
  setAsyncOutput(next);
  if (next.status !== "running") {
    cancelledAsyncJobs.delete(job_id);
    updates.emit(eventKey("finished", next.job_id), next);
  }
  return next;
}

function aggregateValue(value?: ExecuteCodeAggregate): string | number | null {
  if (value == null) return null;
  return typeof value === "object" ? value.value : value;
}

function sameAggregate(
  left?: ExecuteCodeAggregate,
  right?: ExecuteCodeAggregate,
): boolean {
  if (left == null || right == null) return left == null && right == null;
  return aggregateValue(left) === aggregateValue(right);
}

// This deliberately matches aggregate(): object values are opaque revisions,
// while scalar values are ordered generations.
function aggregateIsSatisfiedBy(
  requested: ExecuteCodeAggregate | undefined,
  available: ExecuteCodeAggregate | undefined,
  { completed = false }: { completed?: boolean } = {},
): boolean {
  if (requested == null || available == null) {
    return !completed && requested == null && available == null;
  }
  if (typeof requested === "object") {
    return sameAggregate(requested, available);
  }
  if (typeof available === "object") {
    return false;
  }
  return requested <= available;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value != null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function executionFingerprint(opts: ExecuteCodeOptions): string {
  const {
    aggregate: _,
    async_call: __,
    job_key: ___,
    job_group: ____,
    streamCB: _____,
    ...execution
  } = opts;
  return JSON.stringify(stableValue(execution));
}

function createPendingKeyedJob(
  opts: ExecuteCodeOptions,
  fingerprint: string,
): PendingKeyedJob {
  let resolve!: (output: ExecuteCodeOutputAsync) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<ExecuteCodeOutputAsync>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    aggregate: opts.aggregate,
    fingerprint,
    opts: { ...opts },
    promise,
    resolve,
    reject,
  };
}

function parseSecurityDenyLine(line: string): Record<string, string> {
  const payload: Record<string, string> = {};
  for (const token of line.split(/\s+/g).slice(1)) {
    const i = token.indexOf("=");
    if (i <= 0) continue;
    const key = token.slice(0, i);
    const value = token.slice(i + 1);
    if (!key) continue;
    payload[key] = value;
  }
  return payload;
}

function logSecurityDenies(opts: {
  command: string;
  args?: string[];
  stderr: string;
}) {
  const lines = opts.stderr
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(SECURITY_DENY_PREFIX));
  if (!lines.length) return;
  for (const line of lines) {
    const parsed = parseSecurityDenyLine(line);
    log.warn("privilege escalation denied by runtime policy", {
      command: opts.command,
      args: opts.args ?? [],
      deny: parsed,
      raw: line,
    });
  }
}

// Async/await interface to executing code.
export async function executeCode(
  opts: ExecuteCodeRequest,
): Promise<ExecuteCodeOutput> {
  return await callback_opts(execute_code)(opts);
}

// Callback interface to executing code.
// This callback interface is retained for older callers.
const executeCodeWithCallback = (
  opts: ExecuteCodeOptionsWithCallback,
): void => {
  (async () => {
    try {
      let data = await executeCodeNoAggregate(opts);
      if (isExecuteCodeOptionsAsyncGet(opts) && data.type === "async") {
        // stats could contain a lot of data. we only return it if requested.
        if (opts.async_stats !== true) {
          data = { ...data, stats: undefined };
        }
      }
      opts.cb?.(undefined, data);
    } catch (err) {
      opts.cb?.(err as Error);
    }
  })();
};

const aggregateExecuteCode: ExecuteCodeFunctionWithCallback = aggregate(
  executeCodeWithCallback,
);

export const execute_code: ExecuteCodeFunctionWithCallback = (opts): void => {
  // Keyed async jobs implement aggregation over the whole process lifetime.
  // The generic aggregate wrapper only covers the short startup call.
  if (
    "command" in opts &&
    opts.async_call === true &&
    typeof opts.job_key === "string"
  ) {
    executeCodeWithCallback(opts);
  } else {
    aggregateExecuteCode(opts);
  }
};

export async function cleanUpTempDir(tempDir: string | undefined) {
  if (tempDir) {
    try {
      await rm(tempDir, { force: true, recursive: true });
    } catch (err) {
      console.log("WARNING: issue cleaning up tempDir", err);
    }
  }
}

function waitForAsyncJob(job_id: string): Promise<ExecuteCodeOutputAsync> {
  return new Promise((resolve) => {
    const key = eventKey("finished", job_id);
    const done = (output: ExecuteCodeOutputAsync) => resolve(output);
    updates.once(key, done);
    const current = getAsyncJob(job_id);
    if (current != null && current.status !== "running") {
      updates.off(key, done);
      resolve(current);
    }
  });
}

export async function cancelAsyncJob(
  job_id: string,
): Promise<ExecuteCodeOutputAsync> {
  const current = getAsyncJob(job_id);
  if (current == null) {
    throw new Error(`Async operation '${job_id}' does not exist.`);
  }
  if (current.status !== "running") return current;

  cancelledAsyncJobs.add(job_id);
  const finished = waitForAsyncJob(job_id);
  try {
    if (current.pid == null) {
      throw new Error(`Async operation '${job_id}' has no process id.`);
    }
    process.kill(-current.pid, "SIGKILL");
  } catch (err) {
    const output = asyncCacheUpdate(job_id, {
      status: "killed",
      elapsed_s: (Date.now() - current.start) / 1000,
      stderr:
        current.stderr ||
        `Unable to signal async operation '${job_id}': ${err}`,
      exit_code: current.exit_code || 1,
    });
    emitAsyncStreamEvent(
      { async_call: true, job_id },
      { type: "done", data: output },
    );
    return output;
  }
  return await finished;
}

function createAsyncJobOutput(
  opts: ExecuteCodeOptions,
  job_id = uuid(),
): ExecuteCodeOutputAsync {
  return {
    type: "async",
    stdout: "",
    stderr: "",
    exit_code: 0,
    start: Date.now(),
    job_id,
    status: "running",
    stats: [],
    job_key: opts.job_key,
    job_group: opts.job_group,
    aggregate: opts.aggregate,
  };
}

async function prepareExecution(opts: ExecuteCodeOptions): Promise<{
  opts: ExecuteCodeOptions;
  origCommand: string;
  tempDir?: string;
}> {
  opts = { ...opts, args: [...(opts.args ?? [])] };
  if (!opts.bash) return { opts, origCommand: "" };

  const origCommand = opts.command;
  const command =
    opts.timeout && opts.ulimit_timeout
      ? `ulimit -t ${Math.ceil(opts.timeout)}\n${opts.command}`
      : opts.command;
  const tempDir = await mkdtemp(join(tmpdir(), "cocalc-"));
  const tempPath = join(tempDir, "a.sh");
  if (opts.verbose) {
    log.debug("writing temp file that contains bash program", tempPath);
  }
  await writeFile(tempPath, command);
  await chmod(tempPath, 0o700);
  return {
    opts: { ...opts, command: "bash", args: [tempPath] },
    origCommand,
    tempDir,
  };
}

async function runBlockingJob(
  opts: ExecuteCodeOptions,
): Promise<ExecuteCodeOutputBlocking> {
  let tempDir: string | undefined;
  try {
    const prepared = await prepareExecution(opts);
    tempDir = prepared.tempDir;
    return await callback(doSpawn, {
      ...prepared.opts,
      origCommand: prepared.origCommand,
    });
  } finally {
    await cleanUpTempDir(tempDir);
  }
}

async function startAsyncJob(
  opts: ExecuteCodeOptions,
  job_config = createAsyncJobOutput(opts),
  onFinished?: (output: ExecuteCodeOutputAsync) => void,
): Promise<ExecuteCodeOutputAsync> {
  opts = {
    ...opts,
    args: [...(opts.args ?? [])],
    max_output: opts.max_output ?? 1024 * 1024,
    timeout: opts.timeout ?? PROJECT_EXEC_DEFAULT_TIMEOUT_S,
  };
  setAsyncOutput(job_config);
  emitAsyncJobGroupEvent(
    {
      job_group: job_config.job_group,
      job_id: job_config.job_id,
      job_key: job_config.job_key,
    },
    { type: "job", data: cloneAsyncOutput(job_config) },
  );

  let tempDir: string | undefined;
  let finished = false;
  const finish = (output: ExecuteCodeOutputAsync) => {
    if (finished) return;
    finished = true;
    onFinished?.(output);
  };

  try {
    const prepared = await prepareExecution(opts);
    tempDir = prepared.tempDir;
    const { job_id, start } = job_config;
    const child = doSpawn(
      {
        ...prepared.opts,
        origCommand: prepared.origCommand,
        job_id,
        job_config,
      },
      async (err, result) => {
        log.debug("async/doSpawn returned", {
          err,
          result: {
            type: result?.type,
            stdout: trunc_middle(result?.stdout),
            stderr: trunc_middle(result?.stderr),
            exit_code: result?.exit_code,
          },
        });
        try {
          const current = getAsyncJob(job_id) ?? job_config;
          const failed = err != null || result == null;
          const output = asyncCacheUpdate(job_id, {
            type: "async",
            job_id,
            stdout: result?.stdout ?? current.stdout,
            stderr:
              (result?.stderr ?? current.stderr) ||
              (failed ? `${err ?? "No result"}` : ""),
            exit_code: result?.exit_code ?? (failed ? 1 : current.exit_code),
            elapsed_s: (Date.now() - start) / 1000,
            start,
            status: failed ? "error" : "completed",
            job_key: job_config.job_key,
            job_group: job_config.job_group,
            aggregate: job_config.aggregate,
          });
          emitAsyncStreamEvent(
            { async_call: true, job_id, streamCB: opts.streamCB },
            { type: "done", data: output },
          );
          finish(output);
        } finally {
          await cleanUpTempDir(tempDir);
        }
      },
    );
    const current = getAsyncJob(job_config.job_id);
    if (current == null || current.status !== "running") {
      return current ?? cloneAsyncOutput(job_config);
    }
    const output = asyncCacheUpdate(job_config.job_id, { pid: child?.pid });
    return cloneAsyncOutput(output);
  } catch (err) {
    const output = asyncCacheUpdate(job_config.job_id, {
      status: "error",
      stderr: `${err}`,
      exit_code: 1,
      elapsed_s: (Date.now() - job_config.start) / 1000,
    });
    emitAsyncStreamEvent(
      { async_call: true, job_id: job_config.job_id, streamCB: opts.streamCB },
      { type: "done", data: output },
    );
    finish(output);
    await cleanUpTempDir(tempDir);
    throw err;
  }
}

function finishKeyedJob(
  job_key: string,
  fingerprint: string,
  aggregate: ExecuteCodeAggregate | undefined,
  output: ExecuteCodeOutputAsync,
) {
  const active = activeKeyedJobs.get(job_key);
  if (active?.job_id !== output.job_id) return;
  activeKeyedJobs.delete(job_key);
  completedKeyedJobs.set(job_key, {
    aggregate,
    fingerprint,
    job_id: output.job_id,
  });

  const pending = pendingKeyedJobs.get(job_key);
  if (pending == null) return;
  pendingKeyedJobs.delete(job_key);
  void claimKeyedAsyncJob(pending.opts, pending.fingerprint).then(
    pending.resolve,
    pending.reject,
  );
}

function claimKeyedAsyncJob(
  opts: ExecuteCodeOptions,
  fingerprint: string,
): Promise<ExecuteCodeOutputAsync> {
  const job_key = opts.job_key!;
  const job_config = createAsyncJobOutput(opts);
  const active: ActiveKeyedJob = {
    aggregate: opts.aggregate,
    fingerprint,
    job_id: job_config.job_id,
  };
  activeKeyedJobs.set(job_key, active);
  const started = startAsyncJob(
    { ...opts, streamCB: undefined },
    job_config,
    (output) => finishKeyedJob(job_key, fingerprint, opts.aggregate, output),
  );
  active.started = started;
  return started;
}

function queueKeyedAsyncJob(
  opts: ExecuteCodeOptions,
  fingerprint: string,
): Promise<ExecuteCodeOutputAsync> {
  const job_key = opts.job_key!;
  const pending = pendingKeyedJobs.get(job_key);
  if (pending == null) {
    const created = createPendingKeyedJob(opts, fingerprint);
    pendingKeyedJobs.set(job_key, created);
    return created.promise;
  }
  if (
    sameAggregate(opts.aggregate, pending.aggregate) &&
    fingerprint !== pending.fingerprint
  ) {
    throw new Error(
      `Async job '${job_key}' was requested with conflicting commands for the same aggregate value.`,
    );
  }
  if (!aggregateIsSatisfiedBy(opts.aggregate, pending.aggregate)) {
    pending.aggregate = opts.aggregate;
    pending.fingerprint = fingerprint;
    pending.opts = { ...opts };
  }
  return pending.promise;
}

async function startOrAttachKeyedAsyncJob(
  opts: ExecuteCodeOptions,
): Promise<ExecuteCodeOutputAsync> {
  const job_key = opts.job_key?.trim();
  if (!job_key) throw new Error("job_key must not be empty");
  if (job_key.length > 8192) throw new Error("job_key is too long");
  opts = { ...opts, job_key };
  const fingerprint = executionFingerprint(opts);
  const active = activeKeyedJobs.get(job_key);
  if (active != null) {
    if (
      sameAggregate(opts.aggregate, active.aggregate) &&
      fingerprint !== active.fingerprint
    ) {
      throw new Error(
        `Async job '${job_key}' was requested with conflicting commands for the same aggregate value.`,
      );
    }
    if (aggregateIsSatisfiedBy(opts.aggregate, active.aggregate)) {
      return await active.started!;
    }
    return await queueKeyedAsyncJob(opts, fingerprint);
  }

  const completed = completedKeyedJobs.get(job_key);
  if (
    completed != null &&
    aggregateIsSatisfiedBy(opts.aggregate, completed.aggregate, {
      completed: true,
    })
  ) {
    if (
      sameAggregate(opts.aggregate, completed.aggregate) &&
      fingerprint !== completed.fingerprint
    ) {
      throw new Error(
        `Async job '${job_key}' was requested with conflicting commands for the same aggregate value.`,
      );
    }
    const output = getAsyncJob(completed.job_id);
    if (output != null) return output;
  }
  return await claimKeyedAsyncJob(opts, fingerprint);
}

// actual implementation, without the aggregate wrapper
async function executeCodeNoAggregate(
  opts: ExecuteCodeRequest,
): Promise<ExecuteCodeOutput> {
  if (isExecuteCodeOptionsAsyncCancel(opts)) {
    return await cancelAsyncJob(opts.async_cancel);
  }
  if (isExecuteCodeOptionsAsyncGet(opts)) {
    const key = opts.async_get;
    const cached = getAsyncJob(key);
    if (cached != null) {
      const { async_await } = opts;
      if (cached.status === "running" && async_await === true) {
        return await waitForAsyncJob(key);
      } else {
        return cached;
      }
    } else {
      throw new Error(`Async operation '${key}' does not exist.`);
    }
  }

  opts.args ??= [];
  opts.timeout ??= PROJECT_EXEC_DEFAULT_TIMEOUT_S;
  opts.ulimit_timeout ??= true;
  opts.err_on_exit ??= true;
  opts.verbose ??= false;

  if (opts.job_group != null) {
    opts.job_group = opts.job_group.trim();
    if (!opts.job_group) throw new Error("job_group must not be empty");
    if (opts.job_group.length > 8192) {
      throw new Error("job_group is too long");
    }
  }

  if (opts.verbose) {
    log.debug(`input: ${opts.command} ${opts.args?.join(" ")}`);
  }
  const s = opts.command.split(/\s+/g); // split on whitespace
  if (opts.args?.length === 0 && s.length > 1) {
    opts.bash = true;
  } else if (opts.bash && opts.args?.length > 0) {
    // Selected bash, but still passed in args.
    opts.command = shellEscape([opts.command].concat(opts.args));
    opts.args = [];
  }

  if (opts.home == null) {
    opts.home = process.env.HOME;
  }

  if (opts.path == null) {
    opts.path = opts.home;
  } else if (opts.path[0] !== "/") {
    opts.path = opts.home + "/" + opts.path;
  }
  if (opts.cwd) {
    opts.path = opts.cwd;
  }
  opts.path = projectRuntimePathForProcess(opts.path);

  if (opts.async_call) {
    if (opts.job_key != null) {
      return await startOrAttachKeyedAsyncJob(opts);
    }
    return await startAsyncJob(opts);
  }
  return await runBlockingJob(opts);
}

function doSpawn(
  opts: ExecuteCodeOptions & {
    origCommand: string;
    job_id?: string;
    job_config?: ExecuteCodeOutputAsync;
  },
  cb?: (err: string | undefined, result?: ExecuteCodeOutputBlocking) => void,
) {
  const start_time = walltime();
  const canStream =
    opts.streamCB != null || (opts.async_call === true && opts.job_id != null);

  if (opts.verbose) {
    log.debug(
      "spawning",
      opts.command,
      "with args",
      opts.args,
      "and timeout",
      opts.timeout,
      "seconds",
    );
  }

  const spawnOptions: SpawnOptionsWithoutStdio = {
    detached: true, // so we can kill the entire process group if it times out
    cwd: opts.path,
    ...(opts.uid ? { uid: opts.uid } : undefined),
    ...(opts.gid ? { uid: opts.gid } : undefined),
    env: {
      ...envForSpawn(),
      ...opts.env,
      ...(opts.uid != null && opts.home ? { HOME: opts.home } : undefined),
    },
    // @ts-ignore -- don't pipe input
    stdio: ["ignore", "pipe", "pipe"],
  };

  // This is the state, which will be captured in closures
  let child: ChildProcessWithoutNullStreams;
  let ran_code = false;
  let stdout = "";
  let stderr = "";
  let exit_code: undefined | number = undefined;
  let stderr_is_done = false;
  let stdout_is_done = false;
  let killed = false;
  let callback_done = false; // set in "finish", which is also called in a timeout
  let timer: NodeJS.Timeout | undefined = undefined;
  const trackedRoot = trackProcessRoot({
    kind: "exec",
    path: opts.path,
    session_id: opts.job_id,
  });

  // periodically check up on the child process tree and record stats
  // this also keeps the entry in the cache alive, when the ttl is less than the duration of the execution
  async function startMonitor() {
    const pid = child.pid;
    const { job_id, job_config } = opts;
    if (job_id == null || pid == null || job_config == null) return;
    const monitor = ProcessStats.getInstance();
    await delay(1000);
    if (callback_done) return;

    while (true) {
      if (callback_done) return;
      let procs: Processes;
      try {
        ({ procs } = await monitor.processes(Date.now()));
      } catch (err) {
        // Process monitoring is best effort and platform dependent.
        // If gathering stats fails (e.g. missing /proc), stop monitoring
        // without failing command execution.
        log.debug("process monitoring unavailable", { err: `${err}` });
        return;
      }
      if (callback_done) return;
      // reconstruct process tree
      const children: { [pid: number]: number[] } = {};
      for (const p of Object.values(procs)) {
        const { pid, ppid } = p;
        children[ppid] ??= [];
        children[ppid].push(pid);
      }
      // we only consider those, which are the pid itself or one of its children
      const sc = sumChildren(procs, children, pid);
      if (sc == null) {
        // If the process by PID is no longer known, either the process was killed or there are too many running.
        // in any case, stop monitoring and do not update any data.
        return;
      }
      const { rss, cpu_pct: pct_cpu, cpu_secs } = sc;
      const obj = activeAsyncOutputs.get(job_id);
      if (obj == null) return;
      obj.pid = pid;
      obj.stats ??= [];
      const statEntry = {
        timestamp: Date.now(),
        mem_rss: rss,
        cpu_pct: pct_cpu,
        cpu_secs,
      };
      obj.stats.push(statEntry);
      truncStats(obj);
      setAsyncOutput(obj);
      // Stream stats update if callback provided
      emitAsyncStreamEvent(opts, { type: "stats", data: statEntry });

      // initially, we record more frequently, but then we space it out up until the interval (probably 1 minute)
      const elapsed_s = (Date.now() - job_config.start) / 1000;
      // i.e. after 6 minutes, we check every minute
      const next_s = Math.max(1, Math.floor(elapsed_s / 6));
      const wait_s = Math.min(next_s, MONITOR_INTERVAL_S);
      await delay(wait_s * 1000);
    }
  }

  try {
    child = spawn(opts.command, opts.args, spawnOptions);
    child.unref();
    if (child.pid != null) {
      trackedRoot.attachPid(child.pid);
    }
    if (child.stdout == null || child.stderr == null) {
      const errorMsg =
        "error creating child process -- couldn't spawn child process";
      cb?.(errorMsg);
      return;
    }
  } catch (error) {
    // Yes, spawn can cause this error if there is no memory, and there's no
    // event! --  Error: spawn ENOMEM
    ran_code = false;
    const errorMsg = `error ${error}`;
    cb?.(errorMsg);
    return;
  }

  ran_code = true;

  if (opts.verbose) {
    log.debug("listening for stdout, stderr and exit_code...");
  }

  // Batching mechanism for streaming to reduce message frequency -- otherwise there could be 100msg/s to process
  let streamBatchTimer: NodeJS.Timeout | undefined;
  const streamBuffer = { stdout: "", stderr: "" };

  // Send batched stream data
  const sendBatchedStream = () => {
    if (!canStream) return;

    const hasStdout = streamBuffer.stdout.length > 0;
    const hasStderr = streamBuffer.stderr.length > 0;

    if (hasStdout || hasStderr) {
      // Send stdout if available
      if (hasStdout) {
        emitAsyncStreamEvent(opts, {
          type: "stdout",
          data: streamBuffer.stdout,
        });
        streamBuffer.stdout = "";
      }
      // Send stderr if available
      if (hasStderr) {
        emitAsyncStreamEvent(opts, {
          type: "stderr",
          data: streamBuffer.stderr,
        });
        streamBuffer.stderr = "";
      }
    }
  };

  // Flush any remaining buffered data and cleanup
  const flushStreamBuffer = () => {
    if (streamBatchTimer) {
      clearInterval(streamBatchTimer);
      streamBatchTimer = undefined;
    }
    sendBatchedStream();
  };

  // Start batch timer if streaming is enabled, every 100ms
  if (canStream) {
    streamBatchTimer = setInterval(sendBatchedStream, 100);
  }

  function update_async(
    job_id: string | undefined,
    aspect: "stdout" | "stderr" | "pid",
    data: string | number,
  ): ExecuteCodeOutputAsync | undefined {
    if (!job_id) return;
    // job_config fallback, in case the cache forgot about it
    const obj = activeAsyncOutputs.get(job_id) ?? opts.job_config;
    if (obj != null) {
      if (aspect === "pid") {
        if (typeof data === "number") {
          obj.pid = data;
        }
      } else if (typeof data === "string") {
        obj[aspect] = data;
      }
      setAsyncOutput(obj);
    }
    return obj;
  }

  child.stdout.on("data", (data) => {
    data = data.toString();
    const prevLength = stdout.length;
    if (opts.max_output != null) {
      if (stdout.length < opts.max_output) {
        const newData = data.slice(0, opts.max_output - stdout.length);
        stdout += newData;
        // Buffer the new portion for batched streaming
        if (canStream && stdout.length > prevLength) {
          streamBuffer.stdout += newData;
        }
      }
    } else {
      stdout += data;
      // Buffer the new data for batched streaming
      if (canStream) {
        streamBuffer.stdout += data;
      }
    }
    update_async(opts.job_id, "stdout", stdout);
  });

  child.stderr.on("data", (data) => {
    data = data.toString();
    const prevLength = stderr.length;
    if (opts.max_output != null) {
      if (stderr.length < opts.max_output) {
        const newData = data.slice(0, opts.max_output - stderr.length);
        stderr += newData;
        // Buffer the new portion for batched streaming
        if (canStream && stderr.length > prevLength) {
          streamBuffer.stderr += newData;
        }
      }
    } else {
      stderr += data;
      // Buffer the new data for batched streaming
      if (canStream) {
        streamBuffer.stderr += data;
      }
    }
    update_async(opts.job_id, "stderr", stderr);
  });

  child.stderr.on("end", () => {
    stderr_is_done = true;
    finish();
  });

  child.stdout.on("end", () => {
    stdout_is_done = true;
    finish();
  });

  // Doc: https://nodejs.org/api/child_process.html#event-exit – read it!
  // A process killed by a signal has a null code. Report it as a failure, as a
  // shell would (128 + signal number): callers such as privileged restores
  // must never treat an externally killed command as successful. It cannot be
  // null, because the "finish" callback assumes that stdout, err and exit are
  // set. The local $killed var is only true if our own timeout killed it.
  child.on("exit", (code, signal) => {
    exit_code = exitCode(code, signal);
    finish();
  });

  // This can happen, e.g., "Error: spawn ENOMEM" if there is no memory.  Without this handler,
  // an unhandled exception gets raised, which is nasty.
  // From docs: "Note that the exit-event may or may not fire after an error has occurred. "
  child.on("error", (err) => {
    if (exit_code == null) {
      exit_code = 1;
    }
    stderr += to_json(err);
    // a fundamental issue, we were not running some code
    ran_code = false;
    finish();
  });

  if (opts.job_id && child.pid) {
    // we don't await it, it runs until $callback_done is true
    update_async(opts.job_id, "pid", child.pid);
    startMonitor();
  }

  const finish = (err?) => {
    if (!killed && (!stdout_is_done || !stderr_is_done || exit_code == null)) {
      // it wasn't killed and none of stdout, stderr, and exit_code hasn't been set.
      // so we let the rest of them get set before actually finishing up.
      return;
    }
    if (callback_done) {
      // we already finished up.
      return;
    }

    // Safety check: if we're using streaming and the process has exited but streams aren't done,
    // force completion after a short delay to prevent hanging
    if (
      canStream &&
      exit_code != null &&
      (!stdout_is_done || !stderr_is_done)
    ) {
      setTimeout(() => {
        if (!callback_done) {
          stdout_is_done = true;
          stderr_is_done = true;
          finish(err);
        }
      }, 1000); // Wait 1 second for streams to complete
      return;
    }
    // finally finish up – this will also terminate the monitor
    callback_done = true;
    trackedRoot.markExited({ pid: child.pid ?? undefined });
    trackedRoot.close();

    // Flush any remaining buffered stream data before finishing
    if (canStream) {
      flushStreamBuffer();
    }

    if (timer != null) {
      clearTimeout(timer);
      timer = undefined;
    }

    if (opts.verbose && log.isEnabled("debug")) {
      log.debug(
        "exec",
        opts.command,
        "took",
        Math.ceil(1000 * walltime(start_time)),
        "milliseconds",
      );
      log.debug({
        stdout: trunc(stdout, 512),
        stderr: trunc(stderr, 512),
        exit_code,
      });
    }
    if (stderr) {
      logSecurityDenies({
        command: opts.command,
        args: opts.args,
        stderr,
      });
    }

    if (opts.max_output != null) {
      if (stdout.length >= opts.max_output) {
        stdout += ` (truncated at ${opts.max_output} characters)`;
      }
      if (stderr.length >= opts.max_output) {
        stderr += ` (truncated at ${opts.max_output} characters)`;
      }
    }
    if (exit_code == null || (err && killed)) {
      exit_code = 1;
    }
    const result: ExecuteCodeOutputBlocking = {
      type: "blocking",
      stdout,
      stderr,
      exit_code,
    };

    // Handle timeout case first - this takes precedence over other error conditions
    if (err && killed) {
      cb?.(err, result);
    } else if (err) {
      cb?.(err, result);
    } else if (opts.err_on_exit && exit_code != 0) {
      const x = opts.origCommand
        ? opts.origCommand
        : `'${opts.command}' (args=${opts.args?.join(" ")})`;
      if (opts.job_id) {
        cb?.(stderr, result);
      } else {
        // sync behavor, like it was before
        cb?.(
          `command '${x}' exited with nonzero code ${exit_code} -- stderr='${trunc(
            stderr,
            1024,
          )}'`,
        );
      }
    } else if (!ran_code) {
      // regardless of opts.err_on_exit !
      const x = opts.origCommand
        ? opts.origCommand
        : `'${opts.command}' (args=${opts.args?.join(" ")})`;
      cb?.(
        `command '${x}' was not able to run -- stderr='${trunc(stderr, 1024)}'`,
        result,
      );
    } else {
      cb?.(undefined, result);
    }
  };

  if (opts.timeout) {
    // setup a timer that will kill the command after a certain amount of time.
    const f = () => {
      if (child.exitCode != null) {
        // command already exited.
        return;
      }
      if (opts.verbose) {
        log.debug(
          "subprocess did not exit after",
          opts.timeout,
          "seconds, so killing with SIGKILL",
        );
      }
      try {
        killed = true; // we set the kill flag in any case – i.e. process will no longer exist
        if (child.pid != null) {
          process.kill(-child.pid, "SIGKILL"); // this should kill process group
        }
      } catch (err) {
        // Exceptions can happen, which left uncaught messes up calling code big time.
        if (opts.verbose) {
          log.debug("process.kill raised an exception", err);
        }
      }
      finish(`killed command '${opts.command} ${opts.args?.join(" ")}'`);
    };
    timer = setTimeout(f, opts.timeout * 1000);
  }

  return child;
}
