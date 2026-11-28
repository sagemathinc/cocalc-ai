/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import { LogRateLimiter } from "./log-rate-limit";

test("allows one line per key per interval and reports the suppressed count", () => {
  let now = 0;
  const limiter = new LogRateLimiter({ intervalMs: 1000, now: () => now });
  expect(limiter.take("a")).toBe(0);
  expect(limiter.take("a")).toBeUndefined();
  expect(limiter.take("a")).toBeUndefined();
  expect(limiter.take("b")).toBe(0);
  now = 1000;
  expect(limiter.take("a")).toBe(2);
  expect(limiter.take("a")).toBeUndefined();
});

test("keeps at most maxKeys keys", () => {
  const limiter = new LogRateLimiter({ maxKeys: 2, now: () => 0 });
  expect(limiter.take("a")).toBe(0);
  expect(limiter.take("b")).toBe(0);
  expect(limiter.take("c")).toBe(0);
  // "a" was evicted, so it logs again rather than growing memory.
  expect(limiter.take("a")).toBe(0);
});
