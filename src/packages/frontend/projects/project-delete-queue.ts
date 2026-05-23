/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useSyncExternalStore } from "react";

import type {
  BulkLeaveOrDeleteProgress,
  LeaveOrDeleteProjectResult,
} from "./projects-bulk-delete";

export type ProjectDeleteQueueSummary = {
  total: number;
  succeeded: number;
  failed: number;
  unprocessed: number;
  stopped: boolean;
  finishedAt: number;
  errors: { project_id: string; error: string }[];
};

type Snapshot = {
  scheduledDeleteProjectIds: string[];
  status: "idle" | "running" | "done" | "error";
  progress: BulkLeaveOrDeleteProgress | null;
  summary: ProjectDeleteQueueSummary | null;
  startedAt?: number;
};

const listeners = new Set<() => void>();

let snapshot: Snapshot = {
  scheduledDeleteProjectIds: [],
  status: "idle",
  progress: null,
  summary: null,
};

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

function setScheduledDeleteProjectIds(project_ids: string[]) {
  if (sameProjectIds(snapshot.scheduledDeleteProjectIds, project_ids)) {
    return;
  }
  snapshot = {
    ...snapshot,
    scheduledDeleteProjectIds: project_ids,
  };
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): Snapshot {
  return snapshot;
}

export function useProjectDeleteQueue(): Snapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function scheduleProjectDeletes(project_ids: string[]) {
  if (project_ids.length === 0) return;
  setScheduledDeleteProjectIds(
    Array.from(
      new Set([...snapshot.scheduledDeleteProjectIds, ...project_ids]),
    ),
  );
}

export function beginProjectDeleteQueue() {
  snapshot = {
    ...snapshot,
    status: "running",
    progress: null,
    summary: null,
    startedAt: Date.now(),
  };
  emit();
}

export function setProjectDeleteQueueProgress(
  progress: BulkLeaveOrDeleteProgress,
) {
  snapshot = {
    ...snapshot,
    status: "running",
    progress,
    summary: null,
  };
  emit();
}

export function finishProjectDeleteQueue({
  results,
  stopped,
  total = results.length,
}: {
  results: LeaveOrDeleteProjectResult[];
  stopped: boolean;
  total?: number;
}) {
  const errors = results
    .filter((result) => result.action === "error")
    .map((result) => ({
      project_id: result.project_id,
      error: result.error ?? "Unknown error",
    }));
  snapshot = {
    ...snapshot,
    status: "done",
    progress: null,
    summary: {
      total,
      succeeded: results.length - errors.length,
      failed: errors.length,
      unprocessed: Math.max(0, total - results.length),
      stopped,
      finishedAt: Date.now(),
      errors,
    },
  };
  emit();
}

export function failProjectDeleteQueue({
  project_ids,
  error,
}: {
  project_ids: string[];
  error: string;
}) {
  snapshot = {
    ...snapshot,
    status: "error",
    progress: null,
    summary: {
      total: project_ids.length,
      succeeded: 0,
      failed: project_ids.length,
      unprocessed: 0,
      stopped: true,
      finishedAt: Date.now(),
      errors: project_ids.map((project_id) => ({ project_id, error })),
    },
  };
  emit();
}

export function clearProjectDeleteQueueStatus() {
  snapshot = {
    scheduledDeleteProjectIds: snapshot.scheduledDeleteProjectIds,
    status: "idle",
    progress: null,
    summary: null,
  };
  emit();
}

export function unscheduleProjectDeletes(project_ids: string[]) {
  if (project_ids.length === 0) return;
  const remove = new Set(project_ids);
  setScheduledDeleteProjectIds(
    snapshot.scheduledDeleteProjectIds.filter((id) => !remove.has(id)),
  );
}

export function retainScheduledProjectDeletes(project_ids: string[]) {
  if (snapshot.scheduledDeleteProjectIds.length === 0) return;
  const retain = new Set(project_ids);
  setScheduledDeleteProjectIds(
    snapshot.scheduledDeleteProjectIds.filter((id) => retain.has(id)),
  );
}

function sameProjectIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
