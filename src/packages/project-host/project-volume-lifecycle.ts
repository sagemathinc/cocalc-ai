/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const lifecycleGenerations = new Map<string, number>();
const lifecycleTails = new Map<string, Promise<void>>();

export function currentProjectVolumeLifecycleGeneration(
  project_id: string,
): number {
  return lifecycleGenerations.get(project_id) ?? 0;
}

export function invalidateProjectVolumeLifecycle(project_id: string): number {
  const generation = currentProjectVolumeLifecycleGeneration(project_id) + 1;
  lifecycleGenerations.set(project_id, generation);
  return generation;
}

export function assertProjectVolumeLifecycleGeneration(
  project_id: string,
  expected_generation: number,
): void {
  const current = currentProjectVolumeLifecycleGeneration(project_id);
  if (current !== expected_generation) {
    throw new Error(
      `project volume lifecycle changed for ${project_id}: expected generation ${expected_generation}, current ${current}`,
    );
  }
}

async function acquireProjectVolumeLifecycleLock(
  project_id: string,
): Promise<() => void> {
  const previous = lifecycleTails.get(project_id) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  lifecycleTails.set(project_id, tail);
  await previous;
  return () => {
    release();
    if (lifecycleTails.get(project_id) === tail) {
      lifecycleTails.delete(project_id);
    }
  };
}

export interface ProjectVolumeLifecycleLock {
  // Run fn without the lock, so lifecycle work queued meanwhile (a scratch
  // reset before a start, a deletion) is not stuck behind fn, then wait for
  // the lock again behind that work. Anything learned about the volume before
  // fn may be stale afterwards: recheck it before relying on it.
  unlocked<T>(fn: () => Promise<T>): Promise<T>;
}

export async function withProjectVolumeLifecycleLock<T>(
  project_id: string,
  fn: (lock: ProjectVolumeLifecycleLock) => Promise<T>,
): Promise<T> {
  let release = await acquireProjectVolumeLifecycleLock(project_id);
  let held = true;
  const lock: ProjectVolumeLifecycleLock = {
    unlocked: async (inner) => {
      if (!held) {
        throw new Error("project volume lifecycle lock is already released");
      }
      held = false;
      release();
      try {
        return await inner();
      } finally {
        release = await acquireProjectVolumeLifecycleLock(project_id);
        held = true;
      }
    },
  };
  try {
    return await fn(lock);
  } finally {
    release();
  }
}

export async function withCurrentProjectVolumeLifecycleLock<T>(
  project_id: string,
  expected_generation: number,
  fn: (lock: ProjectVolumeLifecycleLock) => Promise<T>,
): Promise<T | undefined> {
  return await withProjectVolumeLifecycleLock(project_id, async (lock) => {
    if (
      currentProjectVolumeLifecycleGeneration(project_id) !==
      expected_generation
    ) {
      return undefined;
    }
    return await fn(lock);
  });
}

export function resetProjectVolumeLifecycleForTesting(): void {
  lifecycleGenerations.clear();
  lifecycleTails.clear();
}
