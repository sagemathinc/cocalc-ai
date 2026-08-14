/*
 *  This file is part of CoCalc: Copyright © 2020–2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
 * Backend exec-stream functionality for streaming code execution.
 * Uses the `updates` EventEmitter as a single streaming source,
 * so ALL callers (first and late joiners) get live streaming uniformly.
 */

import {
  ExecuteCodeOutput,
  ExecuteCodeOutputAsync,
} from "@cocalc/util/types/execute-code";
import { asyncCache, eventKey, executeCode, updates } from "./execute-code";
import getLogger from "./logger";
import { abspath } from "./misc_node";

export type StreamEvent = {
  type?: "job" | "stdout" | "stderr" | "stats" | "done" | "error";
  data?: any;
  error?: string;
};

const logger = getLogger("backend:exec-stream");

export interface ExecuteStreamOptions {
  command?: string;
  args?: string[];
  path?: string;
  bash?: boolean;
  env?: { [key: string]: string };
  timeout?: number;
  max_output?: number;
  err_on_exit?: boolean;
  verbose?: boolean;
  project_id?: string;
  debug?: string;
  // aggregate value (e.g. save timestamp/hash): calls with the same command
  // and aggregate are deduped to one backend job — this is how late joiners
  // attach to an already-running build and stream its output.
  aggregate?: string | number;
  /**
   * Attach to an existing job instead of executing anything.
   *
   * A client whose stream dropped knows the job id, and that id is stable
   * for the life of the job. Re-executing with the same aggregate is NOT a
   * substitute: the aggregate wrapper only retains a completed call's result
   * for 60s, and an async exec "completes" as soon as the job is created, so
   * a reconnect a few minutes into a build would start a SECOND process.
   */
  attach_job_id?: string;
  stream: (event: StreamEvent | null) => void;
}

export async function executeStream(
  options: ExecuteStreamOptions,
): Promise<ExecuteCodeOutput | undefined> {
  const { stream, debug, project_id, attach_job_id, ...opts } = options;

  if (debug) {
    logger.debug(
      `executeStream: ${debug}${attach_job_id ? ` (attach ${attach_job_id})` : ""}`,
    );
  }

  try {
    let done = false;

    let job: ExecuteCodeOutput | undefined;
    if (attach_job_id) {
      // Re-attach only: never execute. If the job is gone from the cache
      // there is nothing to attach to, and starting a replacement here
      // would silently double-run the user's build.
      const existing = asyncCache.get(attach_job_id);
      if (existing == null) {
        stream({ error: `no such job ${attach_job_id}` });
        stream(null);
        return undefined;
      }
      job = existing;
    } else {
      // Start async execution WITHOUT streamCB — we use updates EventEmitter
      // instead. This ensures ALL callers (first and late joiners) get live
      // streaming uniformly via the same event source, eliminating duplicate
      // event problems.
      job = await executeCode({
        command: opts.command || "",
        path: abspath(opts.path ?? ""),
        ...opts,
        async_call: true,
      });
    }

    if (job?.type !== "async") {
      stream({ error: "Failed to create async job for streaming" });
      stream(null);
      return undefined;
    }

    const jobId = job.job_id;

    // Snapshot the job's accumulated output NOW (synchronously, same tick as
    // the subscriptions below, so no chunk can slip between snapshot and
    // subscribe). The snapshot lengths let us discard the overlap between
    // the snapshot and live chunks: the asyncCache is updated immediately on
    // every data event, while `updates` emits from a ≤100ms batch buffer, so
    // a late joiner's snapshot may already contain bytes that are emitted
    // again on the next flush. Each emit carries the chunk's absolute
    // offset (`at`) for exactly this reconciliation.
    const snapshot = asyncCache.get(jobId);
    const snapshotStdoutLen = (snapshot?.stdout ?? "").length;
    const snapshotStderrLen = (snapshot?.stderr ?? "").length;
    const dropSnapshotOverlap = (
      snapLen: number,
      data: string,
      at?: number,
    ): string => {
      if (typeof at !== "number") return data; // no offset info — pass through
      const overlap = snapLen - at;
      if (overlap <= 0) return data;
      if (overlap >= data.length) return "";
      return data.slice(overlap);
    };

    // Subscribe to live streaming events BEFORE sending initial job info
    // (to avoid missing chunks between job info send and listener registration)
    const handleStdout = (data: string, at?: number) => {
      if (done) return;
      const fresh = dropSnapshotOverlap(snapshotStdoutLen, data, at);
      if (fresh) stream({ type: "stdout", data: fresh });
    };
    const handleStderr = (data: string, at?: number) => {
      if (done) return;
      const fresh = dropSnapshotOverlap(snapshotStderrLen, data, at);
      if (fresh) stream({ type: "stderr", data: fresh });
    };
    const handleStats = (data: any) => {
      if (!done) stream({ type: "stats", data });
    };
    const cleanup = () => {
      updates.off(eventKey("stdout", jobId), handleStdout);
      updates.off(eventKey("stderr", jobId), handleStderr);
      updates.off(eventKey("stats", jobId), handleStats);
      updates.off(eventKey("finished", jobId), handleFinished);
    };
    const handleFinished = (result: ExecuteCodeOutputAsync) => {
      cleanup();
      if (done) return;
      stream({ type: "done", data: result });
      done = true;
      stream(null);
    };

    updates.on(eventKey("stdout", jobId), handleStdout);
    updates.on(eventKey("stderr", jobId), handleStderr);
    updates.on(eventKey("stats", jobId), handleStats);
    updates.once(eventKey("finished", jobId), handleFinished);

    // Send initial job info — the exact snapshot the overlap-dedup above is
    // calibrated against. Bytes past the snapshot arrive via the updates
    // listeners; bytes inside it are sliced off incoming chunks.
    const currentJob = snapshot;
    const initialJobInfo: ExecuteCodeOutputAsync = {
      type: "async",
      job_id: job.job_id,
      pid: job.pid,
      status: currentJob?.status ?? job.status,
      start: job.start,
      stdout: currentJob?.stdout ?? "",
      stderr: currentJob?.stderr ?? "",
      exit_code: currentJob?.exit_code ?? 0,
      stats: currentJob?.stats ?? [],
    };

    stream({ type: "job", data: initialJobInfo });

    // If job already completed, send done event immediately
    if (!done && currentJob && currentJob.status !== "running") {
      cleanup();
      stream({ type: "done", data: currentJob });
      done = true;
      stream(null);
      return currentJob;
    }

    return job;
  } catch (err) {
    stream({ error: `${err}` });
    stream(null);
    return undefined;
  }
}
