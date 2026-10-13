/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
A project's storage quota is sometimes raised for a moment, e.g. so that Btrfs
can add a snapshot to a project at its limit. Nothing may write into the
project meanwhile, or the writes would keep the extra space.

Everything on this host that writes into a project (the file API, copies and
restores into it, starting it) holds a shared write lease for the duration.
A fence is exclusive: it is only taken while no lease is held, never waits
for one, and makes new writers wait until it is released. Taking a fence and
taking a lease are each synchronous once they proceed, so they cannot
interleave.
*/

const leases = new Map<string, number>();
const fences = new Map<string, Promise<void>>();

/** Hold a write lease for project_id until the returned release is called. */
export async function acquireProjectWriteLease(
  project_id: string,
): Promise<() => void> {
  for (;;) {
    const fence = fences.get(project_id);
    if (fence == null) break;
    await fence;
  }
  leases.set(project_id, (leases.get(project_id) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (leases.get(project_id) ?? 1) - 1;
    if (remaining > 0) {
      leases.set(project_id, remaining);
    } else {
      leases.delete(project_id);
    }
  };
}

export async function withProjectWriteLease<T>(
  project_id: string,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await acquireProjectWriteLease(project_id);
  try {
    return await fn();
  } finally {
    release();
  }
}

export class ProjectWriteFenceUnavailableError extends Error {
  constructor(project_id: string, reason: string) {
    super(`project ${project_id} cannot be fenced against writes: ${reason}`);
    this.name = "ProjectWriteFenceUnavailableError";
  }
}

/**
 * Run fn while nothing can write into project_id. Throws
 * ProjectWriteFenceUnavailableError, without waiting, if a write is in
 * progress or another fence is held.
 */
export async function withProjectWriteFence<T>(
  project_id: string,
  fn: () => Promise<T>,
): Promise<T> {
  if ((leases.get(project_id) ?? 0) > 0) {
    throw new ProjectWriteFenceUnavailableError(
      project_id,
      "a write is in progress",
    );
  }
  if (fences.has(project_id)) {
    throw new ProjectWriteFenceUnavailableError(project_id, "already fenced");
  }
  let release!: () => void;
  fences.set(
    project_id,
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  try {
    return await fn();
  } finally {
    fences.delete(project_id);
    release();
  }
}

export function resetProjectWriteFenceForTesting(): void {
  leases.clear();
  fences.clear();
}
