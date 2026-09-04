/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export function createInflightRequestCoalescer<T>() {
  const inflight = new Map<string, Promise<T>>();
  return async (key: string, load: () => Promise<T>): Promise<T> => {
    const existing = inflight.get(key);
    if (existing) return await existing;

    const request = Promise.resolve().then(load);
    inflight.set(key, request);
    try {
      return await request;
    } finally {
      if (inflight.get(key) === request) inflight.delete(key);
    }
  };
}
