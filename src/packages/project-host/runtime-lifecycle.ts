/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getProject, upsertProject } from "./sqlite/projects";

const lifecycleTails = new Map<string, Promise<void>>();
const lifecycleRevisions = new Map<string, number>();
const lifecycleQueued = new Map<string, number>();

// Each queued operation holds one of the host's shared RPC handler slots while
// it waits. One project whose start or stop hangs must not use them all, so
// further operations for it fail fast instead of queueing without bound.
export const MAX_QUEUED_LIFECYCLE_OPERATIONS_PER_PROJECT = 16;

function normalizeRevision(value: unknown): number | undefined {
  const revision = Number(value);
  return Number.isFinite(revision) && revision >= 0
    ? Math.floor(revision)
    : undefined;
}

// Checks a requested revision against the project's current one and records a
// newer one. Synchronous, so no other lifecycle step interleaves with it.
function admitRevision({
  project_id,
  revision,
  require_revision,
  allow_unversioned,
}: {
  project_id: string;
  revision?: number;
  require_revision?: boolean;
  allow_unversioned?: boolean;
}): void {
  let current = lifecycleRevisions.get(project_id);
  if (current == null) {
    current =
      normalizeRevision(getProject(project_id)?.runtime_lifecycle_revision) ??
      0;
    lifecycleRevisions.set(project_id, current);
  }
  const requested = normalizeRevision(revision);
  if (requested == null) {
    if (require_revision || (current > 0 && !allow_unversioned)) {
      throw new Error(
        `runtime lifecycle revision required for project ${project_id}`,
      );
    }
  } else if (requested < current) {
    throw new Error(
      `stale runtime lifecycle for project ${project_id}: requested ${requested}, current ${current}`,
    );
  } else if (requested > current) {
    upsertProject({
      project_id,
      runtime_lifecycle_revision: requested,
    });
    lifecycleRevisions.set(project_id, requested);
  }
}

export async function withProjectRuntimeLifecycle<T>({
  project_id,
  revision,
  require_revision,
  allow_unversioned,
  fn,
}: {
  project_id: string;
  revision?: number;
  require_revision?: boolean;
  allow_unversioned?: boolean;
  fn: () => Promise<T>;
}): Promise<T> {
  const queued = lifecycleQueued.get(project_id) ?? 0;
  if (queued >= MAX_QUEUED_LIFECYCLE_OPERATIONS_PER_PROJECT) {
    throw Object.assign(
      new Error(
        `project ${project_id} has ${queued} runtime lifecycle operations waiting; try again later`,
      ),
      { code: 503 },
    );
  }
  lifecycleQueued.set(project_id, queued + 1);
  const previous = lifecycleTails.get(project_id);
  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  lifecycleTails.set(project_id, tail);
  try {
    if (previous) await previous;
    admitRevision({
      project_id,
      revision,
      require_revision,
      allow_unversioned,
    });
    return await fn();
  } finally {
    const left = (lifecycleQueued.get(project_id) ?? 1) - 1;
    if (left > 0) lifecycleQueued.set(project_id, left);
    else lifecycleQueued.delete(project_id);
    release();
    if (lifecycleTails.get(project_id) === tail) {
      lifecycleTails.delete(project_id);
    }
  }
}

// For authority updates that are safe without the queue (the collaborator map,
// whose own revision keeps only the newest list): they need the restart fence,
// but waiting behind a start or stop that hangs would block agent and browser
// token issuance for the project, and pile up handlers until the host's whole
// API refuses every request.
export function applyProjectRuntimeAuthorityUpdate<T>({
  project_id,
  revision,
  fn,
}: {
  project_id: string;
  revision?: number;
  fn: () => T;
}): T {
  admitRevision({ project_id, revision });
  return fn();
}

export function resetProjectRuntimeLifecycleForTesting(): void {
  lifecycleTails.clear();
  lifecycleRevisions.clear();
  lifecycleQueued.clear();
}
