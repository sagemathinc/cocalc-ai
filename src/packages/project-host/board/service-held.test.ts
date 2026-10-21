/*
daybreak2 (#1236 round 9): a refused writer's unsaved text held in memory is
charged in real bytes, never dropped on time or for the refusal messages'
count, and dropped only past its byte bound, logged and counted.
*/

import { heldUnsavedStats, lastRefusal, rememberRefusal } from "./service";

const memory = (message = "refused") => ({
  state: "refused" as const,
  code: "instance",
  message,
  unsaved: { in: "memory" as const, error: "ENOSPC" },
});
const inFile = {
  state: "refused" as const,
  code: "instance",
  message: "refused",
  unsaved: { in: "file" as const },
};

let n = 0;
const key = () => `p:/held-${process.pid}-${n++}.board.json`;

test("held text is charged in UTF-8 bytes plus a per-entry overhead", () => {
  const before = heldUnsavedStats();
  const k = key();
  // 1,000 three-byte characters: 1,000 code units, 3,000 bytes.
  rememberRefusal(k, memory(), "€".repeat(1000));
  const after = heldUnsavedStats();
  expect(after.entries - before.entries).toBe(1);
  expect(after.bytes - before.bytes).toBe(3000 + 4096);
  expect(lastRefusal(k)?.text).toBe("€".repeat(1000));
});

test("the refusal messages' count bound never evicts held text", () => {
  const k = key();
  rememberRefusal(k, memory(), "keep me");
  for (let i = 0; i < 1500; i++) rememberRefusal(key(), inFile);
  expect(lastRefusal(k)).toMatchObject({ text: "keep me" });
});

test("held text never expires on time; a refusal without it does", () => {
  const withText = key();
  const without = key();
  rememberRefusal(withText, memory(), "still here");
  rememberRefusal(without, inFile);
  const now = Date.now();
  const spy = jest.spyOn(Date, "now").mockReturnValue(now + 2 * 3600_000);
  try {
    expect(lastRefusal(without)).toBeUndefined();
    expect(lastRefusal(withText)).toMatchObject({ text: "still here" });
  } finally {
    spy.mockRestore();
  }
});

test("past the byte bound: the oldest is dropped, logged and counted", () => {
  const dropped = heldUnsavedStats().dropped;
  const keys = [key(), key(), key(), key(), key()];
  // 5 x 20 MiB: over the 64 MiB bound, so the oldest go.
  for (const k of keys) {
    rememberRefusal(k, memory(), "x".repeat(20 * 1024 * 1024));
  }
  const stats = heldUnsavedStats();
  expect(stats.bytes).toBeLessThanOrEqual(64 * 1024 * 1024);
  expect(stats.dropped - dropped).toBeGreaterThanOrEqual(2);
  expect(lastRefusal(keys[0])?.text).toBeUndefined();
  expect(lastRefusal(keys[4])?.text).toHaveLength(20 * 1024 * 1024);
});
