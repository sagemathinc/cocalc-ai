/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createSharedWorkLimit } from "./shared-work-limit";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("createSharedWorkLimit", () => {
  let time = 0;
  const now = () => time;
  const make = (overrides = {}) =>
    createSharedWorkLimit<string>({
      maxConcurrent: 2,
      maxWaiting: 1,
      reuseMs: 1000,
      maxEntries: 10,
      busyMessage: "busy",
      now,
      ...overrides,
    });

  beforeEach(() => {
    time = 0;
  });

  it("shares an in-flight run and briefly reuses its result", async () => {
    const limit = make();
    const work = deferred<string>();
    const run = jest.fn(() => work.promise);
    const a = limit("k", run);
    const b = limit("k", run);
    work.resolve("report");
    await expect(Promise.all([a, b])).resolves.toEqual(["report", "report"]);
    expect(run).toHaveBeenCalledTimes(1);

    time = 999;
    await expect(limit("k", run)).resolves.toBe("report");
    expect(run).toHaveBeenCalledTimes(1);
    time = 1000;
    await limit("k", async () => "fresh");
    await expect(limit("k", run)).resolves.toBe("fresh");
  });

  it("does not reuse failures", async () => {
    const limit = make();
    await expect(
      limit("k", async () => {
        throw new Error("scan failed");
      }),
    ).rejects.toThrow("scan failed");
    await expect(limit("k", async () => "ok")).resolves.toBe("ok");
  });

  it("limits concurrent runs and the wait queue", async () => {
    const limit = make();
    const first = deferred<string>();
    const second = deferred<string>();
    let started = 0;
    const a = limit("a", () => {
      started += 1;
      return first.promise;
    });
    const b = limit("b", () => {
      started += 1;
      return second.promise;
    });
    const c = limit("c", async () => {
      started += 1;
      return "c";
    });
    await flush();
    expect(started).toBe(2);
    await expect(limit("d", async () => "d")).rejects.toThrow("busy");

    first.resolve("a");
    await expect(c).resolves.toBe("c");
    expect(started).toBe(3);
    second.resolve("b");
    await expect(Promise.all([a, b])).resolves.toEqual(["a", "b"]);
  });
});
