/*
daybreak2 (#1236 round 9): a refused writer's unsaved text held in memory is
charged in real bytes, never dropped on time or for the refusal messages'
count, and dropped only past its byte bound, logged and counted.
*/

import {
  heldUnsavedStats,
  lastRefusal,
  rememberRefusal,
  saveHeldUnsaved,
} from "./service";

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

describe("astra: each refusal's text is its own generation", () => {
  test("a second refusal of a board keeps the first's text too", () => {
    const k = key();
    const before = heldUnsavedStats().entries;
    rememberRefusal(k, memory("first"), "OLD text");
    rememberRefusal(k, memory("second"), "NEW text");
    expect(heldUnsavedStats().entries - before).toBe(2);
    expect(lastRefusal(k)).toMatchObject({
      unsaved: { in: "memory" },
      text: "NEW text",
      held: 2,
    });
  });

  // A filesystem whose first writeFile waits until released.
  function slowFs() {
    const files = new Map<string, string>();
    let release!: () => void;
    let first = true;
    const fs: any = {
      writeFile: async (p: string, text: string) => {
        if (first) {
          first = false;
          await new Promise<void>((r) => (release = r));
        }
        files.set(p, text);
      },
      move: async (from: string, to: string) => {
        files.set(to, files.get(from)!);
        files.delete(from);
      },
      unlink: async (p: string) => {
        files.delete(p);
      },
    };
    return { fs, files, release: () => release() };
  }

  test("a newer text held while an older one is being saved stays held, unsaved", async () => {
    const k = key();
    const { fs, files, release } = slowFs();
    rememberRefusal(k, memory("old"), "OLD text");
    const saving = saveHeldUnsaved(k, fs, "/b.board.json");
    // Meanwhile, a second refusal holds NEW.
    await new Promise((r) => setImmediate(r));
    rememberRefusal(k, memory("new"), "NEW text");
    release();
    await saving;
    const after = lastRefusal(k)!;
    expect(after).toMatchObject({
      unsaved: { in: "memory" },
      text: "NEW text",
      held: 1,
    });
    expect(after.copies).toHaveLength(1);
    expect(files.get(after.copies![0])).toBe("OLD text");
    // The next open saves NEW too.
    await saveHeldUnsaved(k, fs, "/b.board.json");
    const done = lastRefusal(k)!;
    expect(done.text).toBeUndefined();
    expect(done.copies).toHaveLength(2);
    expect(done.unsaved).toEqual({ in: "copy", path: done.copies![1] });
    expect(files.get(done.copies![1])).toBe("NEW text");
  });
});
