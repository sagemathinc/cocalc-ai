/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Native copyFile/copyFileNoReplace/rm run on the shared libuv worker pool.
// Bound how many run at once, per process, so a burst of large or slow
// operations cannot occupy every worker and stall unrelated fs/dns/zlib work
// for the other projects this process serves. The cap leaves headroom below
// the pool size (UV_THREADPOOL_SIZE, libuv default 4).
const UV_POOL_SIZE = (() => {
  const n = parseInt(process.env.UV_THREADPOOL_SIZE ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 4;
})();
const MAX_NATIVE_FS_CONCURRENCY = (() => {
  const override = parseInt(
    process.env.COCALC_SANDBOX_MAX_NATIVE_FS_CONCURRENCY ?? "",
    10,
  );
  if (Number.isFinite(override) && override > 0) {
    return override;
  }
  return Math.max(1, Math.floor(UV_POOL_SIZE / 2));
})();

let nativeFsActive = 0;
const nativeFsWaiters: Array<() => void> = [];

// Counting semaphore with direct slot handoff (no decrement/re-increment race).
// Shared by every host-side caller of such operations (the sandbox and
// project-host's beneath-copy), so there is one per-process bound.
export async function runNativeFsTask<T>(fn: () => Promise<T>): Promise<T> {
  if (nativeFsActive < MAX_NATIVE_FS_CONCURRENCY) {
    nativeFsActive++;
  } else {
    await new Promise<void>((resolve) => nativeFsWaiters.push(resolve));
  }
  try {
    return await fn();
  } finally {
    const next = nativeFsWaiters.shift();
    if (next != null) {
      next(); // transfer this slot to the next waiter; active count unchanged
    } else {
      nativeFsActive--;
    }
  }
}
