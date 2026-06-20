import getLogger from "@cocalc/backend/logger";
import { btrfs } from "./util";

const logger = getLogger("file-server:btrfs:operation-cache");

type BtrfsOutput = Awaited<ReturnType<typeof btrfs>>;

type CacheEntry<T> = {
  expires: number;
  value: T;
};

const qgroupShowCache = new Map<string, CacheEntry<BtrfsOutput>>();
const qgroupShowInflight = new Map<string, Promise<BtrfsOutput>>();
const subvolumeShowCache = new Map<string, CacheEntry<BtrfsOutput>>();
const subvolumeShowInflight = new Map<string, Promise<BtrfsOutput>>();
const mutationTails = new Map<string, Promise<void>>();

function envDurationMs(name: string, fallback: number): number {
  const value = Number.parseInt(`${process.env[name] ?? ""}`, 10);
  if (Number.isFinite(value) && value >= 0) {
    return value;
  }
  return fallback;
}

function qgroupShowCacheMs(): number {
  return envDurationMs("COCALC_BTRFS_QGROUP_SHOW_CACHE_MS", 2_000);
}

function subvolumeShowCacheMs(): number {
  return envDurationMs("COCALC_BTRFS_SUBVOLUME_SHOW_CACHE_MS", 1_000);
}

async function cached<T>({
  cache,
  inflight,
  key,
  ttlMs,
  run,
}: {
  cache: Map<string, CacheEntry<T>>;
  inflight: Map<string, Promise<T>>;
  key: string;
  ttlMs: number;
  run: () => Promise<T>;
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
  const promise = (async () => {
    const value = await run();
    if (ttlMs > 0) {
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

export async function cachedBtrfsQgroupShowRaw(
  mount: string,
): Promise<BtrfsOutput> {
  return await cached({
    cache: qgroupShowCache,
    inflight: qgroupShowInflight,
    key: mount,
    ttlMs: qgroupShowCacheMs(),
    run: async () =>
      await btrfs({
        verbose: false,
        args: ["qgroup", "show", "-prc", "--raw", mount],
      }),
  });
}

export function invalidateBtrfsQgroupShowRaw(mount: string): void {
  qgroupShowCache.delete(mount);
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
    run: async () =>
      await btrfs({
        args: ["subvolume", "show", path],
        err_on_exit: errOnExit,
        verbose: false,
      }),
  });
}

export function invalidateBtrfsSubvolumeShow(path: string): void {
  subvolumeShowCache.delete(`strict:${path}`);
  subvolumeShowCache.delete(`lenient:${path}`);
}

export async function withBtrfsMutationLock<T>({
  mount,
  operation,
  run,
}: {
  mount: string;
  operation: string;
  run: () => Promise<T>;
}): Promise<T> {
  const existing = mutationTails.get(mount);
  const previous = existing ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(
    () => current,
    () => current,
  );
  mutationTails.set(mount, chained);
  if (existing) {
    logger.debug("waiting for btrfs mutation lock", { mount, operation });
  }
  await previous.catch(() => undefined);
  try {
    return await run();
  } finally {
    release();
    if (mutationTails.get(mount) === chained) {
      mutationTails.delete(mount);
    }
  }
}

export function clearBtrfsOperationCachesForTest(): void {
  qgroupShowCache.clear();
  qgroupShowInflight.clear();
  subvolumeShowCache.clear();
  subvolumeShowInflight.clear();
  mutationTails.clear();
}
