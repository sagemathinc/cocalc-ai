/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import type { CollaborationSourceIssue } from "@cocalc/util/collaboration-census";
import getLogger from "@cocalc/backend/logger";
import { changedChatArchives } from "@cocalc/backend/chat-store/sqlite-offload";
import { CollaborationCensusStore } from "@cocalc/backend/collaborators/census-store";
import { censusCapacityFromEnvironment } from "@cocalc/backend/collaborators/census-types";
import { censusPolicyFromEnvironment } from "@cocalc/backend/collaborators/census-policy";
import type { CensusPolicy } from "@cocalc/backend/collaborators/census-policy";
import type {
  CensusRun,
  CensusCapacity,
} from "@cocalc/backend/collaborators/census-types";
import { createCensusProducer } from "@cocalc/backend/collaborators/census-producer";
import { censusReporter } from "@cocalc/backend/collaborators/census-report";
import type { CollaborationDiscoveryWrite } from "@cocalc/util/collaboration-census";
import type { CollaborationReconciliationStatus } from "@cocalc/util/collaboration-census";
import { getProject } from "./sqlite/projects";
import { getLocalHostId } from "./sqlite/hosts";
import { getRecordedProjectVolumeIdentity } from "./sqlite/project-volumes";
import {
  assertProjectVolumeLifecycleGeneration,
  currentProjectVolumeLifecycleGeneration,
  withProjectVolumeLifecycleLock,
} from "./project-volume-lifecycle";

const ROOT = "/home/user";
const EXCLUDED = [ROOT + "/.snapshots"];
const RECONCILE_COOLDOWN_MS = 5 * 60_000;
const logger = getLogger("project-host:collaborators:census");
function unavailable(code: string) {
  return Object.assign(Error(`collaboration census ${code}`), { code });
}

export function createHostedCollaborationCensus(options: {
  filename: string;
  getFilesystem(project_id: string): Promise<SandboxedFilesystem>;
  /** Existing host-authenticated, owner-routed metadata check; no initialization. */
  authorize(project_id: string): Promise<void>;
  current(project_id: string): Promise<{ run_id: string | null }>;
  report(write: CollaborationDiscoveryWrite): Promise<unknown>;
  sourceProgress?(
    project_id: string,
    run_id: string,
  ): {
    source_pending: number;
    source_errors: number;
    source_file_errors?: number;
  };
  sourceIssues?(project_id: string, run_id: string): CollaborationSourceIssue[];
  enabled(): Promise<boolean>;
  onError(error: unknown): void;
  now?: () => number;
  capacity?: CensusCapacity;
  policy?: CensusPolicy;
}) {
  const policy = options.policy ?? censusPolicyFromEnvironment();
  const store = new CollaborationCensusStore(
    options.filename,
    options.capacity ?? censusCapacityFromEnvironment(),
  );
  const now = options.now ?? Date.now;
  function scope(project_id: string) {
    const project = getProject(project_id);
    const host = getLocalHostId();
    if (!project || project.local_only || project.exam_run_id || !host)
      throw unavailable("PROJECT_UNAVAILABLE");
    return {
      authority: `host:${host}`,
      volume_id:
        getRecordedProjectVolumeIdentity(project_id, "home") ?? "unavailable",
    };
  }
  function assertLocal(run: CensusRun) {
    const current = scope(run.project_id);
    if (run.volume_id === "unavailable") throw unavailable("ENODEV");
    if (
      current.authority !== run.authority ||
      current.volume_id !== run.volume_id
    )
      throw unavailable("ESTALE");
  }
  const validate = async (run: CensusRun) => {
    assertLocal(run);
    if (!(await options.enabled())) throw unavailable("DISABLED");
    await options.authorize(run.project_id);
    assertLocal(run);
  };
  const producer = createCensusProducer({
    store,
    enabled: options.enabled,
    now,
    onError: options.onError,
    publish: censusReporter({
      store,
      current: options.current,
      send: options.report,
      now,
      enabled: options.enabled,
    }),
    validate,
    discover: async (run) => {
      await validate(run);
      const generation = currentProjectVolumeLifecycleGeneration(
        run.project_id,
      );
      const fs = await withProjectVolumeLifecycleLock(
        run.project_id,
        async () => {
          assertProjectVolumeLifecycleGeneration(run.project_id, generation);
          assertLocal(run);
          return options.getFilesystem(run.project_id);
        },
      );
      try {
        const started = performance.now();
        const result = await fs.fd(run.root, {
          pattern: "\\.chat$",
          options: [
            "--hidden",
            "--no-ignore",
            "--one-file-system",
            "--exclude",
            ".snapshots",
            "--type",
            "f",
            "--case-sensitive",
            "--print0",
            "--color",
            "never",
            "--max-results",
            String(run.limits.candidates + 1),
          ],
          timeout: 10_000,
          maxSize: 8 * 1024 * 1024,
        });
        assertProjectVolumeLifecycleGeneration(run.project_id, generation);
        assertLocal(run);
        if (result.truncated || result.code !== 0)
          throw unavailable(
            result.truncated ? "SEARCH_INCOMPLETE" : "SEARCH_FAILED",
          );
        // NUL-delimited output preserves filenames containing newlines. Paths
        // are untrusted hints; ordinary fenced source reads validate them later.
        const paths = result.stdout
          .toString("utf8")
          .split("\0")
          .filter(Boolean)
          .map((path) => {
            const relative = path.replace(/^\.\//, "");
            if (relative.startsWith("/") || relative.split("/").includes(".."))
              throw unavailable("INVALID_SEARCH_PATH");
            return `${run.root}/${relative}`;
          });
        const { last_success } = store.scanTimes(run.project_id);
        let changed = paths;
        if (last_success != null) {
          const archives = new Set(
            changedChatArchives({
              root: await fs.safeAbsPath(run.root),
              since: last_success,
              limit: run.limits.candidates,
            }),
          );
          changed = [];
          for (const path of paths) {
            const stat = await fs.lstat(path);
            if (
              stat.mtimeMs >= last_success ||
              (archives.size && archives.has(await fs.safeAbsPath(path)))
            )
              changed.push(path);
          }
        }
        assertProjectVolumeLifecycleGeneration(run.project_id, generation);
        assertLocal(run);
        logger.debug("manual scan filename discovery", {
          project_id: run.project_id,
          run_id: run.run_id,
          candidates: changed.length,
          unchanged: paths.length - changed.length,
          elapsed_ms: Math.round(performance.now() - started),
        });
        return changed;
      } finally {
        fs.close();
      }
    },
  });
  /** Trusted owner adapter only. Public actor admission, durable request
   * receipts, and a follow-up boundary belong above this host entry point.
   * A busy scan is not coalesced: its captured scope may precede new writes.
   */
  async function requestReconciliation(opts: {
    project_id: string;
    run_id: string;
    expected_run_id?: string;
  }) {
    if (!(await options.enabled())) throw unavailable("DISABLED");
    if (store.isCancelled(opts)) throw unavailable("CANCELLED");
    const current = scope(opts.project_id);
    const generation = currentProjectVolumeLifecycleGeneration(opts.project_id);
    const request: CensusRun = {
      project_id: opts.project_id,
      run_id: opts.run_id,
      ...current,
      root: ROOT,
      policy_version: policy.version,
      limits: policy.limits,
      excluded_paths: EXCLUDED,
    };
    await validate(request);
    return withProjectVolumeLifecycleLock(opts.project_id, async () => {
      assertProjectVolumeLifecycleGeneration(opts.project_id, generation);
      assertLocal(request);
      if (!(await options.enabled())) throw unavailable("DISABLED");
      assertProjectVolumeLifecycleGeneration(opts.project_id, generation);
      assertLocal(request);
      if (store.isCancelled(opts)) throw unavailable("CANCELLED");
      const prior = store.status(opts.project_id);
      if (prior?.run.run_id === opts.run_id) {
        // begin performs canonical argument comparison for an idempotent retry.
        store.begin(request, opts.expected_run_id, now());
        return {
          admission: "accepted" as const,
          run_id: opts.run_id,
          replayed: true,
        };
      }
      if (prior && prior.run.run_id !== opts.expected_run_id)
        throw Error("census replacement requires the current run id");
      // The owner supplied a new admitted identity and explicitly named this
      // predecessor. Retire quarantined automatic inventory without resuming it.
      if (prior?.blocked_reason === "manual_required") store.cancel(prior.run);
      const sameScope =
        prior?.run.authority === request.authority &&
        prior.run.volume_id === request.volume_id &&
        prior.run.root === request.root;
      if (
        prior &&
        sameScope &&
        !store.isCancelled(prior.run) &&
        (!prior.traversal_complete || prior.pending_candidates)
      )
        return {
          admission: "deferred" as const,
          reason: "BUSY",
          run_id: prior.run.run_id,
        };
      const retry_after_ms = prior
        ? prior.started_at + RECONCILE_COOLDOWN_MS - now()
        : 0;
      if (retry_after_ms > 0)
        return {
          admission: "throttled" as const,
          run_id: prior!.run.run_id,
          retry_after_ms,
        };
      const run =
        prior && sameScope && !store.isCancelled(prior.run)
          ? store.rescan(request, prior.run.run_id, now())
          : store.begin(request, opts.expected_run_id, now());
      if (!run)
        return {
          admission: "deferred" as const,
          reason: "REPORT_PENDING",
          run_id: prior!.run.run_id,
        };
      return {
        admission: "accepted" as const,
        run_id: run.run_id,
        replayed: false,
      };
    });
  }
  async function reconciliationStatus(opts: {
    project_id: string;
    run_id: string;
  }): Promise<CollaborationReconciliationStatus> {
    if (store.isCancelled(opts)) {
      await producer.pause();
      return { state: "cancelled", run_id: opts.run_id };
    }
    const current = scope(opts.project_id);
    const generation = currentProjectVolumeLifecycleGeneration(opts.project_id);
    await options.authorize(opts.project_id);
    if (!(await options.enabled())) throw unavailable("DISABLED");
    assertProjectVolumeLifecycleGeneration(opts.project_id, generation);
    const after = scope(opts.project_id);
    if (
      after.authority !== current.authority ||
      after.volume_id !== current.volume_id
    )
      throw unavailable("ESTALE");
    let status = store.status(opts.project_id);
    if (!status) return { state: "unknown" };
    assertLocal(status.run);
    if (status.run.run_id !== opts.run_id)
      return { state: "unknown", current_run_id: status.run.run_id };
    status = store.status(opts.project_id)!;
    const progress = options.sourceProgress?.(opts.project_id, opts.run_id) ?? {
      source_pending: 0,
      source_errors: 0,
    };
    const settled =
      status.traversal_complete &&
      status.pending_candidates === 0 &&
      progress.source_pending <= progress.source_errors;
    if (
      status.blocked_reason ||
      (settled &&
        (status.errors ||
          progress.source_errors > (progress.source_file_errors ?? 0)))
    )
      store.finishScan(opts, false);
    else if (settled) store.finishScan(opts, true);
    return {
      ...store.scanTimes(opts.project_id),
      state: progress.source_errors
        ? "partial"
        : status.coverage === "complete"
          ? progress.source_pending
            ? "indexing"
            : "discovered"
          : status.coverage,
      ...progress,
      source_issues: options.sourceIssues?.(opts.project_id, opts.run_id),
      run_id: status.run.run_id,
      started_at: status.started_at,
      traversal_complete: status.traversal_complete,
      blocked_directories: status.blocked_directories,
      blocked_reason: status.blocked_reason,
      directories: status.directories,
      completed_directories: status.completed_directories,
      entries: status.entries,
      candidates: status.candidates,
      pending_candidates: status.pending_candidates,
      errors: status.errors,
    };
  }
  async function cancelReconciliation(opts: {
    project_id: string;
    run_id: string;
  }) {
    // Privileged owner RPC, deliberately available while new admissions are disabled.
    store.finishScan(opts, false);
    store.cancel(opts);
    await producer.pause();
    return { state: "cancelled" as const, run_id: opts.run_id };
  }
  return {
    store,
    producer,
    requestReconciliation,
    reconciliationStatus,
    cancelReconciliation,
  };
}
