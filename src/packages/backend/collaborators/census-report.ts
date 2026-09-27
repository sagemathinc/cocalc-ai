/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { CollaborationDiscoveryWrite } from "@cocalc/util/collaboration-census";
import { validateDiscoveryReport } from "@cocalc/util/collaboration-census";
import type { CollaborationCensusStore } from "./census-store";
import type { CollaborationJournal } from "./journal";

interface Checkpoint {
  write: CollaborationDiscoveryWrite;
  acknowledged: boolean;
  retry_at: number;
}

/** One small durable telemetry outbox per project, retried with the same CAS. */
export function censusReporter(options: {
  store: CollaborationCensusStore;
  current(project_id: string): Promise<{ run_id: string | null }>;
  send(write: CollaborationDiscoveryWrite): Promise<unknown>;
  now?: () => number;
  batchSize?: number;
  budgetMs?: number;
  enabled?(): Promise<boolean> | boolean;
}) {
  const now = options.now ?? Date.now;
  const batchSize = options.batchSize ?? 16;
  const budgetMs = options.budgetMs ?? 500;
  if (
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 100 ||
    !Number.isFinite(budgetMs) ||
    budgetMs <= 0
  )
    throw Error("invalid census report budget");
  async function publish(journal: CollaborationJournal, project_id: string) {
    const status = options.store.status(project_id)!;
    const previous = options.store.reportCheckpoint(project_id);
    let checkpoint: Checkpoint | undefined = previous
      ? JSON.parse(previous)
      : undefined;
    if (checkpoint && checkpoint.write.report.run_id !== status.run.run_id)
      checkpoint = undefined;
    if (checkpoint && now() < checkpoint.retry_at) return;
    if (!checkpoint || checkpoint.acknowledged) {
      const progress = journal.censusProgress(project_id);
      const expected_run_id = checkpoint
        ? checkpoint.write.expected_run_id
        : (await options.current(project_id)).run_id;
      const report = validateDiscoveryReport({
        run_id: status.run.run_id,
        sequence: (checkpoint?.write.report.sequence ?? 0) + 1,
        coverage:
          status.coverage === "partial" || progress.source_errors
            ? "partial"
            : status.coverage === "complete" && !progress.source_pending
              ? "complete"
              : "indexing",
        traversal_complete: status.traversal_complete,
        directories: status.directories,
        completed_directories: status.completed_directories,
        entries: status.entries,
        candidates: status.candidates,
        pending_candidates: status.pending_candidates,
        excluded_entries: status.excluded_entries,
        skipped_symlinks: status.skipped_symlinks,
        blocked_directories: status.blocked_directories,
        errors: status.errors,
        ...progress,
      });
      checkpoint = {
        write: { project_id, expected_run_id, report },
        acknowledged: false,
        retry_at: 0,
      };
    }
    // Persist before sending, including backoff if process exits during the RPC.
    checkpoint.retry_at = now() + 30_000;
    options.store.setReportCheckpoint(project_id, JSON.stringify(checkpoint));
    if (options.enabled && !(await options.enabled())) return;
    try {
      await options.send(checkpoint.write);
    } catch (error) {
      // Rehome intentionally drops this rebuildable telemetry. Only an empty
      // current owner record permits reanchoring; never steal another live run.
      const current = await options.current(project_id);
      if (
        current.run_id === null &&
        checkpoint.write.expected_run_id !== null
      ) {
        checkpoint.write.expected_run_id = null;
        options.store.setReportCheckpoint(
          project_id,
          JSON.stringify(checkpoint),
        );
      }
      throw error;
    }
    checkpoint.acknowledged = true;
    options.store.setReportCheckpoint(project_id, JSON.stringify(checkpoint));
  }
  return async (journal: CollaborationJournal) => {
    const start = now();
    const visited = new Set<string>();
    let failure: unknown;
    for (
      let i = 0;
      i < batchSize && (i === 0 || now() - start < budgetMs);
      i++
    ) {
      if (options.enabled && !(await options.enabled())) break;
      const after = options.store.checkpoint("report-project") ?? "";
      const project_id =
        options.store.nextProject(after) ?? options.store.nextProject();
      if (!project_id || visited.has(project_id)) break;
      visited.add(project_id);
      // Advance before RPC; one inaccessible owner cannot starve later projects.
      options.store.setCheckpoint("report-project", project_id);
      try {
        await publish(journal, project_id);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  };
}
