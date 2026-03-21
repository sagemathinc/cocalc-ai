/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { delay } from "awaiting";

import { asyncDebounce, asyncThrottle } from "./async-debounce-throttle";

describe("async debounce/throttle helpers", () => {
  it("asyncDebounce batches trailing calls and resolves all waiters", async () => {
    const seen: number[] = [];
    const f = asyncDebounce(
      async (n: number) => {
        seen.push(n);
      },
      20,
      { leading: false, trailing: true },
    );

    await Promise.all([f(1), f(2), f(3)]);
    expect(seen).toEqual([3]);
  });

  it("asyncDebounce cancel prevents the pending invocation", async () => {
    const seen: number[] = [];
    const f = asyncDebounce(
      async (n: number) => {
        seen.push(n);
      },
      20,
      { leading: false, trailing: true },
    );

    void f(5);
    f.cancel();
    await delay(40);
    expect(seen).toEqual([]);
  });

  it("asyncThrottle supports trailing-only mode", async () => {
    const seen: number[] = [];
    const f = asyncThrottle(
      async (n: number) => {
        seen.push(n);
      },
      20,
      { leading: false, trailing: true },
    );

    const promise = f(7);
    expect(seen).toEqual([]);
    await promise;
    expect(seen).toEqual([7]);
  });

  it("asyncThrottle exposes cancel for scheduled trailing work", async () => {
    const seen: number[] = [];
    const f = asyncThrottle(
      async (n: number) => {
        seen.push(n);
      },
      20,
      { leading: false, trailing: true },
    );

    void f(9);
    f.cancel();
    await delay(40);
    expect(seen).toEqual([]);
  });
});
