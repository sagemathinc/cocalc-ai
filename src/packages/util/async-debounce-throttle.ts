/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { DebounceSettings, ThrottleSettings } from "lodash";

type Timer = ReturnType<typeof setTimeout>;

type AsyncScheduled<T extends (...args: any[]) => Promise<any>> = ((
  ...args: Parameters<T>
) => Promise<void>) & {
  cancel: () => void;
};

function unrefTimer(timer: Timer | undefined): void {
  (timer as any)?.unref?.();
}

function createDeferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

function createQueue() {
  let queue: ReturnType<typeof createDeferred>[] = [];
  return {
    push() {
      const deferred = createDeferred();
      queue.push(deferred);
      return deferred.promise;
    },
    resolveAll() {
      const current = queue;
      queue = [];
      for (const deferred of current) {
        deferred.resolve();
      }
    },
    rejectAll(err: unknown) {
      const current = queue;
      queue = [];
      for (const deferred of current) {
        deferred.reject(err);
      }
    },
    clear() {
      queue = [];
    },
    get length() {
      return queue.length;
    },
  };
}

export function asyncDebounce<T extends (...args: any[]) => Promise<any>>(
  func: T,
  wait: number,
  options?: DebounceSettings,
): AsyncScheduled<T> {
  const leading = options?.leading ?? false;
  const trailing = options?.trailing ?? true;
  const queue = createQueue();
  let timer: Timer | undefined;
  let lastArgs: Parameters<T> | undefined;
  let lastThis: any;
  let hadCallSinceLastInvoke = false;
  let running = false;

  const clearTimer = () => {
    if (timer != null) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const invoke = async () => {
    const args = lastArgs;
    const thisArg = lastThis;
    lastArgs = undefined;
    lastThis = undefined;
    hadCallSinceLastInvoke = false;
    running = true;
    try {
      await func.apply(thisArg, args ?? []);
      queue.resolveAll();
    } catch (err) {
      queue.rejectAll(err);
      throw err;
    } finally {
      running = false;
    }
  };

  const schedule = () => {
    clearTimer();
    timer = setTimeout(async () => {
      timer = undefined;
      if (trailing && hadCallSinceLastInvoke && !running) {
        void invoke().catch(() => {});
      }
    }, wait);
    unrefTimer(timer);
  };

  const wrapped = function (this: any, ...args: Parameters<T>): Promise<void> {
    const promise = queue.push();
    lastArgs = args;
    lastThis = this;
    hadCallSinceLastInvoke = true;

    const shouldInvokeLeading = leading && timer == null && !running;
    if (shouldInvokeLeading) {
      void invoke().catch(() => {});
    }

    if (!shouldInvokeLeading || trailing) {
      schedule();
    }

    return promise;
  } as AsyncScheduled<T>;

  wrapped.cancel = () => {
    clearTimer();
    lastArgs = undefined;
    lastThis = undefined;
    hadCallSinceLastInvoke = false;
    queue.clear();
  };

  return wrapped;
}

export function asyncThrottle<T extends (...args: any[]) => Promise<any>>(
  func: T,
  wait: number,
  options?: ThrottleSettings,
): AsyncScheduled<T> {
  const leading = options?.leading ?? true;
  const trailing = options?.trailing ?? true;
  const queue = createQueue();
  let timer: Timer | undefined;
  let lastArgs: Parameters<T> | undefined;
  let lastThis: any;
  let lastInvokeTime = 0;
  let running = false;
  let pendingTrailing = false;

  const clearTimer = () => {
    if (timer != null) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const invoke = async (time: number) => {
    const args = lastArgs;
    const thisArg = lastThis;
    lastArgs = undefined;
    lastThis = undefined;
    pendingTrailing = false;
    lastInvokeTime = time;
    running = true;
    try {
      await func.apply(thisArg, args ?? []);
      queue.resolveAll();
    } catch (err) {
      queue.rejectAll(err);
      throw err;
    } finally {
      running = false;
    }
  };

  const scheduleTrailing = (delay: number) => {
    clearTimer();
    timer = setTimeout(async () => {
      timer = undefined;
      if (trailing && pendingTrailing && !running) {
        void invoke(Date.now()).catch(() => {});
      }
    }, delay);
    unrefTimer(timer);
  };

  const wrapped = function (this: any, ...args: Parameters<T>): Promise<void> {
    const promise = queue.push();
    const now = Date.now();
    lastArgs = args;
    lastThis = this;

    if (lastInvokeTime === 0 && !leading) {
      pendingTrailing = true;
      scheduleTrailing(wait);
      return promise;
    }

    const remaining = wait - (now - lastInvokeTime);
    if (lastInvokeTime === 0 || remaining <= 0 || remaining > wait) {
      clearTimer();
      void invoke(now).catch(() => {});
      return promise;
    }

    if (trailing) {
      pendingTrailing = true;
      scheduleTrailing(remaining);
    }

    return promise;
  } as AsyncScheduled<T>;

  wrapped.cancel = () => {
    clearTimer();
    lastArgs = undefined;
    lastThis = undefined;
    pendingTrailing = false;
    queue.clear();
  };

  return wrapped;
}
