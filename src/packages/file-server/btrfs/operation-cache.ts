import getLogger from "@cocalc/backend/logger";
import {
  type BtrfsMutationContext,
  type BtrfsMutationPriority,
  effectiveBtrfsMutationContext,
  withBtrfsMutationContext,
} from "./mutation-context";
import { btrfs } from "./util";
import { invalidateQgroupScan, resetQgroupScansForTest } from "./qgroup-scan";

export {
  type BtrfsMutationContext,
  type BtrfsMutationPriority,
  effectiveBtrfsMutationContext,
  getBtrfsMutationContext,
  withBtrfsMutationContext,
} from "./mutation-context";

const logger = getLogger("file-server:btrfs:operation-cache");

type BtrfsOutput = Awaited<ReturnType<typeof btrfs>>;

type CacheEntry<T> = {
  expires: number;
  value: T;
};

const subvolumeShowCache = new Map<string, CacheEntry<BtrfsOutput>>();
const subvolumeShowInflight = new Map<string, Promise<BtrfsOutput>>();
// bumped when a key is invalidated: a read under way then is never stored
const subvolumeShowGenerations = new Map<string, number>();
const DEFAULT_MUTATION_LOCK_WAIT_MS = 2 * 60_000;

type MutationLockHolder = {
  token: symbol;
  operation: string;
  startedAt: number;
  context: BtrfsMutationContext;
};

type MutationLockWaiter = {
  token: symbol;
  operation: string;
  queuedAt: number;
  context: BtrfsMutationContext;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
};

type MutationLockState = {
  holder: MutationLockHolder;
  waiters: MutationLockWaiter[];
};

export type BtrfsMutationLockStatus = {
  mount: string;
  holder_operation: string;
  held_ms: number;
  queued: number;
  oldest_wait_ms?: number;
  operation_id?: string;
  project_id?: string;
  priority: BtrfsMutationPriority;
  operation_class?: string;
  cgroup_path?: string;
  checkpointable?: boolean;
  yield_requested?: boolean;
  lifecycle_backlog?: number;
  next_waiter_priority?: BtrfsMutationPriority;
  next_waiter_project_id?: string;
};

const mutationLocks = new Map<string, MutationLockState>();
type BackgroundMutationGuard = (
  context: BtrfsMutationContext,
) => string | undefined;
let backgroundMutationGuard: BackgroundMutationGuard | undefined;
const MUTATION_PRIORITY_ORDER: Record<BtrfsMutationPriority, number> = {
  lifecycle: 0,
  interactive: 1,
  scheduled: 2,
  scavenger: 3,
};

function mutationPriority(
  context: BtrfsMutationContext,
): BtrfsMutationPriority {
  return context.priority ?? "interactive";
}

function envDurationMs(name: string, fallback: number): number {
  const value = Number.parseInt(`${process.env[name] ?? ""}`, 10);
  if (Number.isFinite(value) && value >= 0) {
    return value;
  }
  return fallback;
}

function subvolumeShowCacheMs(): number {
  return envDurationMs("COCALC_BTRFS_SUBVOLUME_SHOW_CACHE_MS", 1_000);
}

function mutationLockWaitMs(): number {
  return envDurationMs(
    "COCALC_BTRFS_MUTATION_LOCK_WAIT_MS",
    DEFAULT_MUTATION_LOCK_WAIT_MS,
  );
}

async function cached<T>({
  cache,
  inflight,
  key,
  ttlMs,
  run,
  generations,
}: {
  cache: Map<string, CacheEntry<T>>;
  inflight: Map<string, Promise<T>>;
  key: string;
  ttlMs: number;
  run: () => Promise<T>;
  generations?: Map<string, number>;
}): Promise<T> {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expires > now) {
    return cached.value;
  }
  const pending = inflight.get(key);
  if (pending) {
    return await pending;
  }
  const generation = generations?.get(key) ?? 0;
  const promise = (async () => {
    const value = await run();
    if (ttlMs > 0 && (generations?.get(key) ?? 0) === generation) {
      cache.set(key, { value, expires: Date.now() + ttlMs });
    }
    return value;
  })();
  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    if (inflight.get(key) === promise) {
      inflight.delete(key);
    }
  }
}

// Quota numbers are read once per filesystem and shared (qgroup-scan.ts);
// this drops what was read of the filesystem with `pathOrMount`.
export function invalidateBtrfsQgroupShowRaw(pathOrMount: string): void {
  invalidateQgroupScan(pathOrMount);
}

// The subvolumes at `paths` were replaced or moved (e.g., a restore swapped a
// home): what was read about them, and of their filesystem's quotas, no
// longer holds.
export function forgetSubvolumePaths(...paths: string[]): void {
  for (const path of paths) {
    invalidateBtrfsSubvolumeShow(path);
    invalidateQgroupScan(path);
  }
}

export async function cachedBtrfsSubvolumeShow(
  path: string,
  opts?: { err_on_exit?: boolean },
): Promise<BtrfsOutput> {
  const errOnExit = opts?.err_on_exit ?? true;
  return await cached({
    cache: subvolumeShowCache,
    inflight: subvolumeShowInflight,
    key: `${errOnExit ? "strict" : "lenient"}:${path}`,
    ttlMs: subvolumeShowCacheMs(),
    generations: subvolumeShowGenerations,
    run: async () =>
      await btrfs({
        args: ["subvolume", "show", path],
        err_on_exit: errOnExit,
        verbose: false,
      }),
  });
}

// What was read about the subvolume at `path` no longer holds (e.g., another
// one is there now): dropped, and so is a read under way, which is never
// stored nor given to anyone asking from now on.
export function invalidateBtrfsSubvolumeShow(path: string): void {
  for (const key of [`strict:${path}`, `lenient:${path}`]) {
    subvolumeShowCache.delete(key);
    subvolumeShowInflight.delete(key);
    subvolumeShowGenerations.set(
      key,
      (subvolumeShowGenerations.get(key) ?? 0) + 1,
    );
  }
}

export async function withBtrfsMutationLock<T>({
  mount,
  operation,
  context,
  run,
  wait_ms = mutationLockWaitMs(),
}: {
  mount: string;
  operation: string;
  context?: BtrfsMutationContext;
  run: () => Promise<T>;
  wait_ms?: number;
}): Promise<T> {
  const effectiveContext = effectiveBtrfsMutationContext(context);
  const priority = mutationPriority(effectiveContext);
  const assertBackgroundMutationAllowed = () => {
    if (priority !== "scheduled" && priority !== "scavenger") return;
    const reason = backgroundMutationGuard?.(effectiveContext);
    if (reason) {
      logger.info("deferred background btrfs mutation at lock boundary", {
        mount,
        operation,
        reason,
        ...effectiveContext,
      });
      throw new BtrfsMutationDeferredError(reason);
    }
  };
  // Avoid joining the queue when background work is already ineligible.
  assertBackgroundMutationAllowed();
  const release = await acquireBtrfsMutationLock({
    mount,
    operation,
    context: effectiveContext,
    wait_ms,
  });
  try {
    // Lifecycle state may have changed while this operation waited. The lock
    // is now ours, so this is the final race-free eligibility check before the
    // indivisible transaction begins.
    assertBackgroundMutationAllowed();
    return await withBtrfsMutationContext(
      { ...effectiveContext, mutation_lock_held: true },
      run,
    );
  } finally {
    release();
  }
}

export class BtrfsMutationDeferredError extends Error {
  constructor(public readonly reason: string) {
    super(`background btrfs mutation deferred: ${reason}`);
    this.name = "BtrfsMutationDeferredError";
  }
}

export function configureBtrfsBackgroundMutationGuard(
  guard?: BackgroundMutationGuard,
): void {
  backgroundMutationGuard = guard;
}

async function acquireBtrfsMutationLock({
  mount,
  operation,
  context,
  wait_ms,
}: {
  mount: string;
  operation: string;
  context: BtrfsMutationContext;
  wait_ms: number;
}): Promise<() => void> {
  const token = Symbol(operation);
  const existing = mutationLocks.get(mount);
  if (!existing) {
    const state: MutationLockState = {
      holder: { token, operation, startedAt: Date.now(), context },
      waiters: [],
    };
    mutationLocks.set(mount, state);
    logger.debug("acquired btrfs mutation lock", {
      mount,
      operation,
      ...context,
    });
    return () => releaseBtrfsMutationLock({ mount, token });
  }

  const queuedAt = Date.now();
  logger.debug("waiting for btrfs mutation lock", {
    mount,
    operation,
    ...context,
    holder_operation: existing.holder.operation,
    holder_priority: mutationPriority(existing.holder.context),
    held_ms: queuedAt - existing.holder.startedAt,
    queued: existing.waiters.length + 1,
  });
  return await new Promise<() => void>((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        const state = mutationLocks.get(mount);
        if (!state) return;
        const index = state.waiters.findIndex(
          (waiter) => waiter.token === token,
        );
        if (index < 0) return;
        state.waiters.splice(index, 1);
        const heldMs = Date.now() - state.holder.startedAt;
        const err = new Error(
          `timed out after ${wait_ms}ms waiting for btrfs mutation lock on ${mount}; holder=${state.holder.operation} held_ms=${heldMs}`,
        );
        logger.warn("timed out waiting for btrfs mutation lock", {
          mount,
          operation,
          wait_ms,
          holder_operation: state.holder.operation,
          held_ms: heldMs,
          queued: state.waiters.length,
        });
        reject(err);
      },
      Math.max(0, wait_ms),
    );
    timeout.unref?.();
    const waiter: MutationLockWaiter = {
      token,
      operation,
      queuedAt,
      context,
      timeout,
      resolve,
      reject,
    };
    const priority = MUTATION_PRIORITY_ORDER[mutationPriority(context)];
    const insertionIndex = existing.waiters.findIndex(
      (queued) =>
        MUTATION_PRIORITY_ORDER[mutationPriority(queued.context)] > priority,
    );
    if (insertionIndex < 0) {
      existing.waiters.push(waiter);
    } else {
      existing.waiters.splice(insertionIndex, 0, waiter);
    }
  });
}

function releaseBtrfsMutationLock({
  mount,
  token,
}: {
  mount: string;
  token: symbol;
}): void {
  const state = mutationLocks.get(mount);
  if (!state || state.holder.token !== token) return;

  const released = state.holder;
  const next = state.waiters.shift();
  if (!next) {
    mutationLocks.delete(mount);
    logger.debug("released btrfs mutation lock", {
      mount,
      operation: released.operation,
      ...released.context,
      held_ms: Date.now() - released.startedAt,
      queued: 0,
    });
    return;
  }

  clearTimeout(next.timeout);
  state.holder = {
    token: next.token,
    operation: next.operation,
    startedAt: Date.now(),
    context: next.context,
  };
  logger.debug("handed off btrfs mutation lock", {
    mount,
    released_operation: released.operation,
    released_held_ms: Date.now() - released.startedAt,
    operation: next.operation,
    ...next.context,
    waited_ms: Date.now() - next.queuedAt,
    queued: state.waiters.length,
  });
  next.resolve(() => releaseBtrfsMutationLock({ mount, token: next.token }));
}

export function getBtrfsMutationLockStatus(): BtrfsMutationLockStatus[] {
  const now = Date.now();
  return Array.from(mutationLocks.entries())
    .map(([mount, state]) => ({
      mount,
      holder_operation: state.holder.operation,
      held_ms: Math.max(0, now - state.holder.startedAt),
      queued: state.waiters.length,
      ...state.holder.context,
      priority: mutationPriority(state.holder.context),
      ...(state.waiters[0]
        ? {
            oldest_wait_ms: Math.max(0, now - state.waiters[0].queuedAt),
            next_waiter_priority: mutationPriority(state.waiters[0].context),
            ...(state.waiters[0].context.project_id
              ? {
                  next_waiter_project_id: state.waiters[0].context.project_id,
                }
              : {}),
          }
        : {}),
    }))
    .sort((a, b) => a.mount.localeCompare(b.mount));
}

export function clearBtrfsOperationCachesForTest(): void {
  resetQgroupScansForTest();
  subvolumeShowCache.clear();
  subvolumeShowInflight.clear();
  subvolumeShowGenerations.clear();
  for (const state of mutationLocks.values()) {
    for (const waiter of state.waiters) {
      clearTimeout(waiter.timeout);
    }
  }
  mutationLocks.clear();
  backgroundMutationGuard = undefined;
}
