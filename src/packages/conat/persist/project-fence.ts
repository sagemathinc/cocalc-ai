/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The state of project fences (fence.ts) on this persist server, kept apart so
that util.ts and server.ts can use it without importing fence.ts:

- whether a project is fenced, so getStream waits instead of opening one of
  its disk-backed streams;
- how many opens of its streams are under way past that check;
- which server sockets serve its streams, so the fence can close them;
- the instance its streams report once their files were replaced.
*/

import { ConatError } from "@cocalc/conat/core/client";
import { randomId } from "@cocalc/conat/names";

// How long opening a stream of a fenced project waits for the fence to be
// released.  Then it fails with a retryable error, and the client reconnects
// with backoff and tries again.
export const FENCED_OPEN_WAIT_MS = 15_000;

interface Fence {
  token: string;
  released: Promise<void>;
  release: () => void;
}

const fences = new Map<string, Fence>();
const opening = new Map<string, number>();
const openingDone = new Map<string, Set<() => void>>();
const sockets = new Map<string, Set<() => void>>();
const replacedInstances = new Map<string, string>();

// The project a (normalized, see auth.ts) storage path belongs to.
export function projectOfStoragePath(
  path: string | undefined,
): string | undefined {
  const match = `${path ?? ""}`.match(/^projects\/([^/]+)(?:\/|$)/);
  return match?.[1];
}

export function isProjectFenced(project_id: string): boolean {
  return fences.has(project_id);
}

export function fencedProjects(): string[] {
  return [...fences.keys()];
}

// Whether token holds the project's fence.
export function isProjectFencedBy(project_id: string, token: string): boolean {
  return fences.get(project_id)?.token === token;
}

// Waits while the project is fenced, then counts an open as under way until
// the returned function is called.
export async function enterProjectOpen(
  project_id: string,
  { waitMs = FENCED_OPEN_WAIT_MS }: { waitMs?: number } = {},
): Promise<() => void> {
  const deadline = Date.now() + waitMs;
  let fence = fences.get(project_id);
  while (fence != null) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new ConatError(
        "this project's history is being replaced (e.g., restored); try again",
        { code: 503 },
      );
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      fence.released,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, remaining);
      }),
    ]);
    clearTimeout(timer);
    fence = fences.get(project_id);
  }
  opening.set(project_id, (opening.get(project_id) ?? 0) + 1);
  let left = false;
  return () => {
    if (left) return;
    left = true;
    const n = (opening.get(project_id) ?? 1) - 1;
    if (n > 0) {
      opening.set(project_id, n);
      return;
    }
    opening.delete(project_id);
    const waiters = openingDone.get(project_id);
    openingDone.delete(project_id);
    for (const resolve of waiters ?? []) resolve();
  };
}

// Resolves once no open of the project's streams is under way, or after
// timeoutMs (returning false).
export async function waitForProjectOpens(
  project_id: string,
  timeoutMs: number,
): Promise<boolean> {
  if (!opening.has(project_id)) return true;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => (resolveDone = resolve));
  let waiters = openingDone.get(project_id);
  if (waiters == null) {
    waiters = new Set();
    openingDone.set(project_id, waiters);
  }
  waiters.add(resolveDone);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      done,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    clearTimeout(timer);
    openingDone.get(project_id)?.delete(resolveDone);
  }
  return !opening.has(project_id);
}

// A server socket serving one of the project's disk-backed streams; close is
// called when the project is fenced.  Returns the unregister function.
export function registerProjectSocket(
  project_id: string,
  close: () => void,
): () => void {
  let set = sockets.get(project_id);
  if (set == null) {
    set = new Set();
    sockets.set(project_id, set);
  }
  set.add(close);
  return () => {
    const current = sockets.get(project_id);
    if (current == null) return;
    current.delete(close);
    if (current.size == 0) sockets.delete(project_id);
  };
}

// Closes every registered socket of the project; returns how many.
export function closeProjectSockets(project_id: string): number {
  const set = sockets.get(project_id);
  if (set == null) return 0;
  const closers = [...set];
  for (const close of closers) {
    try {
      close();
    } catch {
      // a socket that fails to close still unregisters when it does
    }
  }
  return closers.length;
}

// Fences the project for token.  Fails (409) if another token holds it;
// acquiring it again with the same token is allowed.
export function beginProjectFence(project_id: string, token: string): void {
  const current = fences.get(project_id);
  if (current != null) {
    if (current.token === token) return;
    throw new ConatError(
      "this project's persistent streams are already fenced; try again later",
      { code: 409 },
    );
  }
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  fences.set(project_id, { token, released, release });
}

// Releases the fence if token holds it (returns whether it did).  If the
// project's files were (or may have been) replaced, its streams report a new
// instance from now on (instance, or a new random one).
export function endProjectFence(
  project_id: string,
  token: string,
  { replaced, instance }: { replaced: boolean; instance?: string },
): boolean {
  const current = fences.get(project_id);
  if (current == null || current.token !== token) return false;
  if (replaced) {
    replacedInstances.set(project_id, instance ?? randomId());
  }
  fences.delete(project_id);
  current.release();
  return true;
}

// The instance the project's streams report since its files were last
// replaced (e.g., loaded from where the fence service keeps them, so that it
// survives a restart: a client that last saw the project before then must
// still learn that it was replaced).
export function setProjectReplacedInstance(
  project_id: string,
  instance: string,
): void {
  replacedInstances.set(project_id, instance);
}

export function projectReplacedInstance(
  project_id: string,
): string | undefined {
  return replacedInstances.get(project_id);
}

// for unit tests
export function resetProjectFences(): void {
  for (const fence of fences.values()) fence.release();
  fences.clear();
  opening.clear();
  openingDone.clear();
  sockets.clear();
  replacedInstances.clear();
}
