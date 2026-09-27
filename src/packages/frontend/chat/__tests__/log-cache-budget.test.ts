import { canCacheActivityLog } from "../log-cache-budget";

test("small logs can be reused while oversized logs cannot be retained", () => {
  expect(canCacheActivityLog([])).toBe(true);
  expect(
    canCacheActivityLog([{ event: { type: "agent", text: "hello" } }]),
  ).toBe(true);
  expect(
    canCacheActivityLog([{ event: { text: "x".repeat(2_000_000) } }]),
  ).toBe(false);
  expect(canCacheActivityLog(Array.from({ length: 2_001 }, () => ({})))).toBe(
    false,
  );
  expect(canCacheActivityLog([{ nested: Array(20_000).fill(0) }])).toBe(false);
});

test("cyclic input cannot cause the budget check to loop indefinitely", () => {
  const cycle: unknown[] = [];
  cycle.push(cycle);
  expect(canCacheActivityLog(cycle)).toBe(false);
});
