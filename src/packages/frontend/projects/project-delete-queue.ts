/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useSyncExternalStore } from "react";

type Snapshot = {
  scheduledDeleteProjectIds: string[];
};

const listeners = new Set<() => void>();

let snapshot: Snapshot = {
  scheduledDeleteProjectIds: [],
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
