/** @jest-environment node */

import {
  evictionOrder,
  GIT_CACHE_MAX_ENTRY_BYTES,
  MemoryGitCache,
} from "./immutable-cache";

test("eviction drops least recently used entries until within budget", () => {
  const entries = [
    { key: "a", bytes: 40, used: 3 },
    { key: "b", bytes: 40, used: 1 },
    { key: "c", bytes: 40, used: 2 },
  ];
  expect(evictionOrder(entries, 120)).toEqual([]);
  expect(evictionOrder(entries, 100)).toEqual(["b"]);
  expect(evictionOrder(entries, 40)).toEqual(["b", "c"]);
});

test("the memory cache keeps recently used entries within its budget", async () => {
  // Strings cost 2 bytes per character.
  const cache = new MemoryGitCache(20);
  await cache.set("a", "aaaa");
  await cache.set("b", "bbbb");
  expect(await cache.get("a")).toBe("aaaa");
  // Over budget: b, the least recently used, goes.
  await cache.set("c", "cccc");
  expect(await cache.get("b")).toBeUndefined();
  expect(await cache.get("a")).toBe("aaaa");
  expect(await cache.get("c")).toBe("cccc");
  // Larger than the whole budget: not kept.
  await cache.set("d", "d".repeat(20));
  expect(await cache.get("d")).toBeUndefined();
  expect(GIT_CACHE_MAX_ENTRY_BYTES).toBeGreaterThan(4_000_000 * 2 - 1);
});
