/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getProject, upsertProject } from "./sqlite/projects";

const lifecycleTails = new Map<string, Promise<void>>();
const lifecycleRevisions = new Map<string, number>();

function normalizeRevision(value: unknown): number | undefined {
  const revision = Number(value);
  return Number.isFinite(revision) && revision >= 0
    ? Math.floor(revision)
    : undefined;
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
  const previous = lifecycleTails.get(project_id);
  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  lifecycleTails.set(project_id, tail);
  if (previous) await previous;
  try {
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
    return await fn();
  } finally {
    release();
    if (lifecycleTails.get(project_id) === tail) {
      lifecycleTails.delete(project_id);
    }
  }
}

export function resetProjectRuntimeLifecycleForTesting(): void {
  lifecycleTails.clear();
  lifecycleRevisions.clear();
}
