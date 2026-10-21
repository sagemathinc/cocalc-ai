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

// A filesystem that saves every copy at once.
function fastFs() {
  const files = new Map<string, string>();
  let writes = 0;
  const fs: any = {
    writeFile: async (p: string, text: string) => {
      writes += 1;
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
  return { fs, files, writes: () => writes };
}

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

describe("daybreak2 (round 12): generations and copies are bounded", () => {
  test("one board holds at most 8 generations; an open saves at most 8", async () => {
    const k = key();
    const before = heldUnsavedStats();
    for (let i = 0; i < 20; i++) rememberRefusal(k, memory(`r${i}`), `T${i}`);
    expect(heldUnsavedStats().entries - before.entries).toBe(8);
    expect(heldUnsavedStats().dropped - before.dropped).toBe(12);
    expect(lastRefusal(k)).toMatchObject({ text: "T19", held: 8, lost: 12 });
    const { fs, files, writes } = fastFs();
    await saveHeldUnsaved(k, fs, "/b.board.json");
    expect(writes()).toBe(8);
    const after = lastRefusal(k)!;
    expect(after.held).toBeUndefined();
    expect(after.copies!.map((c) => files.get(c))).toEqual(
      [12, 13, 14, 15, 16, 17, 18, 19].map((i) => `T${i}`),
    );
    expect(after.unsaved).toEqual({ in: "copy", path: after.copies![7] });
  });

  test("at most 1024 generations in all, oldest dropped first, in O(1) each", () => {
    const before = heldUnsavedStats();
    const keys: string[] = [];
    const t0 = Date.now();
    for (let i = 0; i < 20000; i++) {
      const k = key();
      keys.push(k);
      rememberRefusal(k, memory(), `t${i}`);
    }
    // 20,000 boards: quadratic eviction would scan ~10^7 lists.
    expect(Date.now() - t0).toBeLessThan(5000);
    const stats = heldUnsavedStats();
    expect(stats.entries).toBeLessThanOrEqual(1024);
    expect(stats.dropped - before.dropped).toBeGreaterThanOrEqual(20000 - 1024);
    expect(lastRefusal(keys[19999])).toMatchObject({ text: "t19999" });
    // codex: a dropped generation's refusal says it is lost, not "memory".
    // (The newest boards' refusals are kept: the last dropped one's.)
    const lost = lastRefusal(keys[20000 - 1025])!;
    expect(lost.text).toBeUndefined();
    expect(lost.lost).toBe(1);
    expect(lost.unsaved).toMatchObject({ in: "nowhere" });
    expect(lost.message).toMatch(/LOST/);
  });

  test("refusal/save cycles keep at most 8 copies listed, newest by generation", async () => {
    const k = key();
    const { fs, files } = fastFs();
    for (let i = 0; i < 50; i++) {
      rememberRefusal(k, memory(), `C${i}`);
      await saveHeldUnsaved(k, fs, "/b.board.json");
    }
    const r = lastRefusal(k)!;
    expect(r.copies).toHaveLength(8);
    expect(r.copiesSaved).toBe(50);
    expect(files.get(r.copies![7])).toBe("C49");
    expect(r.unsaved).toEqual({ in: "copy", path: r.copies![7] });
  });

  test("a generation dropped while being saved, and then saved, is not lost", async () => {
    const k = key();
    const { fs, files, release } = slowFs();
    rememberRefusal(k, memory(), "SLOW");
    const saving = saveHeldUnsaved(k, fs, "/b.board.json");
    await new Promise((r) => setImmediate(r));
    // Eight newer generations push SLOW out of the board's bound.
    for (let i = 0; i < 8; i++) rememberRefusal(k, memory(), `N${i}`);
    expect(lastRefusal(k)?.lost).toBe(1);
    release();
    await saving;
    const r = lastRefusal(k)!;
    expect(r.lost).toBeUndefined();
    expect(files.get(r.copies![0])).toBe("SLOW");
  });
});

describe("astra CORR-C07-1: the location is the latest refusal's", () => {
  test("an older saved copy never overrides a newer refusal in the file", async () => {
    const k = key();
    const { fs } = fastFs();
    rememberRefusal(k, memory("old"), "OLD");
    await saveHeldUnsaved(k, fs, "/b.board.json");
    rememberRefusal(k, inFile);
    const r = lastRefusal(k)!;
    expect(r.unsaved).toEqual({ in: "file" });
    expect(r.copies).toHaveLength(1);
  });

  test("nor a newer refusal's own copy", async () => {
    const k = key();
    const { fs } = fastFs();
    rememberRefusal(k, memory("old"), "OLD");
    await saveHeldUnsaved(k, fs, "/b.board.json");
    rememberRefusal(k, {
      ...inFile,
      unsaved: { in: "copy" as const, path: "/b.board.json.unsaved-NEW" },
    });
    expect(lastRefusal(k)!.unsaved).toEqual({
      in: "copy",
      path: "/b.board.json.unsaved-NEW",
    });
  });

  test("copies completing out of order are listed by generation", async () => {
    const k = key();
    const { fs, files, release } = slowFs();
    rememberRefusal(k, memory("old"), "OLD");
    rememberRefusal(k, memory("new"), "NEW");
    // OLD's write waits; a second open skips it and saves NEW first.
    const first = saveHeldUnsaved(k, fs, "/b.board.json");
    await new Promise((r) => setImmediate(r));
    await saveHeldUnsaved(k, fs, "/b.board.json");
    const mid = lastRefusal(k)!;
    expect(mid.unsaved).toEqual({ in: "copy", path: mid.copies![0] });
    expect(files.get(mid.copies![0])).toBe("NEW");
    expect(mid.held).toBe(1);
    release();
    await first;
    const done = lastRefusal(k)!;
    expect(done.copies!.map((c) => files.get(c))).toEqual(["OLD", "NEW"]);
    expect(done.unsaved).toEqual({ in: "copy", path: done.copies![1] });
  });
});

test("astra CORR-C07-2: a copy saved hours after the refusal is still reported", async () => {
  const k = key();
  const { fs, files } = fastFs();
  const now = Date.now();
  rememberRefusal(k, memory(), "HELD_TWO_HOURS");
  const spy = jest.spyOn(Date, "now").mockReturnValue(now + 2 * 3600_000);
  try {
    expect(lastRefusal(k)).toMatchObject({ text: "HELD_TWO_HOURS" });
    // openBoard: save the held text, then report the refusal.
    await saveHeldUnsaved(k, fs, "/b.board.json");
    const r = lastRefusal(k)!;
    expect(r.unsaved).toMatchObject({ in: "copy" });
    expect(files.get((r.unsaved as any).path)).toBe("HELD_TWO_HOURS");
    // ... for an hour from the copy.
    spy.mockReturnValue(now + 2.9 * 3600_000);
    expect(lastRefusal(k)?.unsaved).toMatchObject({ in: "copy" });
    spy.mockReturnValue(now + 3.1 * 3600_000);
    expect(lastRefusal(k)).toBeUndefined();
  } finally {
    spy.mockRestore();
  }
});

test("astra (round 12): a save completing after its board's record was replaced touches nothing", async () => {
  const m = memory();
  const victim = key();
  let done!: (path: string) => void;
  const fs: any = {
    writeFile: () => new Promise<void>((r) => (done = () => r())),
    move: async () => {},
    unlink: async () => {},
  };
  rememberRefusal(victim, m, "OLD");
  const pending = saveHeldUnsaved(victim, fs, "/b.board.json");
  await new Promise((r) => setImmediate(r));
  // OLD is dropped while its copy is pending; global eviction takes the
  // rest; 1,001 refusals without text push the record out.
  for (let i = 0; i < 8; i++) rememberRefusal(victim, m, `H${i}`);
  for (let i = 0; i < 1024; i++) rememberRefusal(key(), m, "H");
  for (let i = 0; i < 1001; i++) rememberRefusal(key(), inFile);
  expect(lastRefusal(victim)).toBeUndefined();
  // A new refusal makes a new record for the key; then OLD's copy lands.
  rememberRefusal(victim, m, "NEW");
  done("");
  await pending;
  expect(lastRefusal(victim)).toMatchObject({ text: "NEW", held: 1 });
  expect(lastRefusal(victim)?.lost).toBeUndefined();
  expect(lastRefusal(victim)?.copies).toBeUndefined();
  // NEW is then dropped: reported lost.
  for (let i = 0; i < 8; i++) rememberRefusal(victim, m, `new-gen-${i}`);
  expect(lastRefusal(victim)).toMatchObject({ lost: 1, text: "new-gen-7" });
});

describe("astra CORR-A633-1: a start's syncdb is closed if its post-replay check fails", () => {
  const history = require("./history");
  const { keptIfUnchanged } = require("./service");
  const step = { client: {} as any, project_id: "p", path: "/b.board.json" };

  test.each([
    ["the inventory read rejects", () => Promise.reject(Error("timeout"))],
    ["the inventory changed", () => Promise.resolve("2:20:2")],
  ])(
    "%s: closed, and the close is finished before it settles",
    async (_, inventory) => {
      const events: string[] = [];
      const opened = {
        close: async () => {
          await new Promise((r) => setTimeout(r, 20));
          events.push("closed");
        },
      };
      const spy = jest
        .spyOn(history, "boardHistoryInventory")
        .mockImplementation(inventory as any);
      try {
        await keptIfUnchanged(opened, "1:10:1", step).then(
          (kept: boolean) => events.push(`kept: ${kept}`),
          (err: Error) => events.push(`threw: ${err.message}`),
        );
      } finally {
        spy.mockRestore();
      }
      expect(events[0]).toBe("closed");
      expect(events).toHaveLength(2);
    },
  );

  test("the same inventory: kept open", async () => {
    const opened = { close: jest.fn(async () => {}) };
    const spy = jest
      .spyOn(history, "boardHistoryInventory")
      .mockResolvedValue("1:10:1");
    try {
      expect(await keptIfUnchanged(opened, "1:10:1", step)).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(opened.close).not.toHaveBeenCalled();
  });
});
