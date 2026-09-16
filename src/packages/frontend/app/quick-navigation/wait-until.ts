/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Like Store.wait, but also disposes the subscription immediately on cancellation.
// Readiness is driven by store/lifecycle events, never a timer polling the DOM.
export function waitUntil<T>(
  read: () => T | undefined,
  subscribe: (check: () => void) => () => void,
  signal: AbortSignal,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Navigation cancelled", "AbortError"));
      return;
    }
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout>;
    let finished = false;
    const cleanup = () => {
      finished = true;
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener("abort", abort);
    };
    const fail = (error: unknown) => {
      if (finished) return;
      cleanup();
      reject(error);
    };
    const abort = () =>
      fail(new DOMException("Navigation cancelled", "AbortError"));
    const check = () => {
      if (finished) return;
      try {
        const value = read();
        if (value !== undefined) {
          cleanup();
          resolve(value);
        }
      } catch (error) {
        fail(error);
      }
    };
    timer = setTimeout(() => fail(Error(message)), 5000);
    signal.addEventListener("abort", abort, { once: true });
    try {
      unsubscribe = subscribe(check);
      if (finished) unsubscribe();
      else check();
    } catch (error) {
      fail(error);
    }
  });
}

export function storeChanges(store: any, event = "change") {
  return (check: () => void) => {
    store.on(event, check);
    return () => store.removeListener(event, check);
  };
}
