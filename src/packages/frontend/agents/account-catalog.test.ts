import { createHash } from "node:crypto";
import { artifactCatalogKey } from "@cocalc/util/artifact-catalog";
import {
  ACCOUNT_CATALOG,
  AccountArtifactCatalog,
  pinEntryId,
  type AccountCatalogHub,
} from "./account-catalog";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const hex = (n: number) => n.toString(16).padStart(64, "0");
const entry = (project_id: string, n: number) => ({
  project_id,
  entry_id: hex(n),
  chat_path: "/home/user/a.chat",
  item: { thread_id: "t", artifact_id: `a${n}`, title: `T${n}` } as any,
});
const versions = (map: Record<string, number>) =>
  Object.fromEntries(
    Object.entries(map).map(([p, seq]) => [p, { epoch: "e", seq }]),
  );
const pinKey = (project_id: string, n: number) =>
  JSON.stringify([project_id, "/home/user/a.chat", "t", `a${n}`]);

function setup(hub: AccountCatalogHub, now = () => clock) {
  return new AccountArtifactCatalog("acct", () => hub, now);
}
let clock = 1_000_000;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  clock = 1_000_000;
});

describe("read mode (R1)", () => {
  test("definite answers are kept, coalesced; a transient failure is asked again", async () => {
    const capabilities = jest.fn(
      async () => ({ list: 1, deltas: 0, hints: 0 }) as const,
    );
    const catalog = setup({
      capabilities,
      listAccount: jest.fn(),
      getEntries: jest.fn(),
    });
    const [a, b] = await Promise.all([catalog.readMode(), catalog.readMode()]);
    expect([a, b]).toEqual(["server", "server"]);
    expect(capabilities).toHaveBeenCalledTimes(1);
    await flush();
    expect(catalog.knownMode).toBe("server");
    await catalog.readMode();
    expect(capabilities).toHaveBeenCalledTimes(1);
  });

  test("list 0, a missing method or an unknown function mean the old catalog", async () => {
    const full = { listAccount: jest.fn(), getEntries: jest.fn() };
    expect(
      await setup({
        ...full,
        capabilities: async () => ({ list: 0, deltas: 0, hints: 0 }),
      }).readMode(),
    ).toBe("legacy");
    expect(await setup({ listAccount: jest.fn() }).readMode()).toBe("legacy");
    expect(
      await setup({
        ...full,
        capabilities: async () => {
          throw Error("unknown function 'artifactCatalog.capabilities'");
        },
      }).readMode(),
    ).toBe("legacy");
  });

  test("a timeout or malformed reply never switches to the old full walk", async () => {
    let fail = true;
    const capabilities = jest.fn(async () => {
      if (fail) throw Error("timeout");
      return { list: 1, deltas: 0, hints: 0 } as const;
    });
    const catalog = setup({
      capabilities,
      listAccount: jest.fn(),
      getEntries: jest.fn(),
    });
    expect(await catalog.readMode()).toBe("unavailable");
    await flush();
    expect(catalog.knownMode).toBeUndefined();
    fail = false;
    expect(await catalog.readMode()).toBe("server");
    expect(capabilities).toHaveBeenCalledTimes(2);
    const odd = setup({
      capabilities: async () => ({}) as any,
      listAccount: jest.fn(),
      getEntries: jest.fn(),
    });
    expect(await odd.readMode()).toBe("unavailable");
  });
});

test("pin entry ids equal the server's derivation", () => {
  const key = pinKey(P1, 7);
  const [project_id, chat_path, thread_id, artifact_id] = JSON.parse(key);
  expect(pinEntryId(key)).toEqual({
    project_id,
    entry_id: createHash("sha256")
      .update(
        artifactCatalogKey(
          { project_id, chat_path },
          { thread_id, artifact_id },
        ),
      )
      .digest("hex"),
  });
});

describe("list sessions (R2, R4)", () => {
  test("a newer request makes older replies stale; double Load more is one call", async () => {
    const replies: ((v: any) => void)[] = [];
    const listAccount = jest.fn(
      () => new Promise<any>((resolve) => replies.push(resolve)),
    );
    const catalog = setup({ listAccount });
    const session = catalog.session(2);
    session.set({ query: "old" });
    session.set({ query: "new" });
    replies[1]({
      entries: [entry(P1, 2)],
      next: `1:${hex(2)}`,
      versions: versions({ [P1]: 1 }),
    });
    replies[0]({ entries: [entry(P1, 9)], versions: versions({ [P1]: 1 }) });
    await flush();
    expect(session.get().entries.map((e) => e.entry_id)).toEqual([hex(2)]);
    void session.loadMore();
    void session.loadMore();
    expect(listAccount).toHaveBeenCalledTimes(3);
    expect(listAccount.mock.calls[2][0]).toMatchObject({
      query: "new",
      before: `1:${hex(2)}`,
      versions: true,
    });
    // A refresh during Load more wins; the Load more reply is dropped.
    void session.refresh();
    replies[2]({ entries: [entry(P1, 3)], versions: versions({ [P1]: 1 }) });
    replies[3]({ entries: [entry(P1, 4)], versions: versions({ [P1]: 1 }) });
    await flush();
    expect(session.get().entries.map((e) => e.entry_id)).toEqual([hex(4)]);
  });

  test("Load more: a project missing from the newest reply is hidden, not revoked, and comes back", async () => {
    const pages: any[] = [
      {
        entries: [entry(P1, 9), entry(P2, 8)],
        next: `8:${hex(8)}`,
        versions: versions({ [P1]: 1, [P2]: 1 }),
      },
      {
        entries: [entry(P1, 7), entry(P1, 9)],
        versions: versions({ [P1]: 1 }),
        incomplete: { unavailable_bays: 1 },
      },
      {
        entries: [entry(P1, 9), entry(P2, 8), entry(P1, 7)],
        versions: versions({ [P1]: 1, [P2]: 1 }),
      },
    ];
    const listAccount = jest.fn(async () => pages.shift());
    const session = setup({ listAccount }).session(2);
    session.set({});
    await flush();
    await session.loadMore();
    expect(session.get().entries.map((e) => e.entry_id)).toEqual([
      hex(9),
      hex(7),
    ]);
    expect(session.get().incomplete).toEqual({ unavailable_bays: 1 });
    await session.refresh();
    expect(session.get().entries.map((e) => e.entry_id)).toEqual([
      hex(9),
      hex(8),
      hex(7),
    ]);
    expect(session.get().incomplete).toBeUndefined();
  });

  test("Load more: a changed version reloads from one snapshot instead of mixing", async () => {
    const pages: any[] = [
      {
        entries: [entry(P1, 9), entry(P1, 8)],
        next: `8:${hex(8)}`,
        versions: versions({ [P1]: 1 }),
      },
      { entries: [entry(P1, 7)], versions: versions({ [P1]: 2 }) },
      {
        entries: [entry(P1, 9), entry(P1, 7)],
        versions: versions({ [P1]: 2 }),
      },
    ];
    const listAccount = jest.fn(async () => pages.shift());
    const session = setup({ listAccount }).session(2);
    session.set({});
    await flush();
    await session.loadMore();
    await flush();
    expect(listAccount).toHaveBeenCalledTimes(3);
    expect(listAccount.mock.calls[2][0]).toMatchObject({
      limit: 4,
      versions: true,
    });
    expect(listAccount.mock.calls[2][0]).not.toHaveProperty("before");
    expect(session.get().entries.map((e) => e.entry_id)).toEqual([
      hex(9),
      hex(7),
    ]);
  });

  test("search waits for typing to pause; duplicates are dropped", async () => {
    jest.useFakeTimers();
    try {
      const listAccount = jest.fn(async () => ({
        entries: [entry(P1, 1), entry(P1, 1)],
        versions: versions({ [P1]: 1 }),
      }));
      const session = setup({ listAccount }).session();
      session.set({});
      session.set({ query: "a" }, true);
      session.set({ query: "ab" }, true);
      session.set({ query: "abc" }, true);
      await jest.advanceTimersByTimeAsync(ACCOUNT_CATALOG.searchDebounceMs);
      // The unfiltered first page, then one search after the pause.
      expect(listAccount).toHaveBeenCalledTimes(2);
      expect(listAccount.mock.calls[1]).toEqual([
        { query: "abc", limit: ACCOUNT_CATALOG.pageLimit, versions: true },
      ]);
      expect(session.get().entries).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("no timers: idle for ten minutes makes no calls; shown again when stale reloads", async () => {
    jest.useFakeTimers();
    try {
      const listAccount = jest.fn(async () => ({
        entries: [],
        versions: {},
      }));
      const catalog = setup({ listAccount });
      catalog.recent.ensure();
      await jest.advanceTimersByTimeAsync(10 * 60_000);
      expect(listAccount).toHaveBeenCalledTimes(1);
      catalog.recent.ensure();
      expect(listAccount).toHaveBeenCalledTimes(1);
      clock += ACCOUNT_CATALOG.staleMs;
      catalog.recent.ensure();
      expect(listAccount).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test("an error shows nothing stale", async () => {
    let fail = false;
    const listAccount = jest.fn(async () => {
      if (fail) throw Error("boom");
      return { entries: [entry(P1, 1)], versions: versions({ [P1]: 1 }) };
    });
    const session = setup({ listAccount }).session();
    await session.refresh();
    fail = true;
    await session.refresh();
    expect(session.get()).toMatchObject({ entries: [], error: "Error: boom" });
  });
});

describe("pins (R3, R4, S2)", () => {
  const readableAll = () => true;

  test("one call for every pin; refresh asks for all of them again", async () => {
    const getEntries = jest.fn(async ({ items }) =>
      items.map((ref) => ({
        ...entry(ref.project_id, 0),
        entry_id: ref.entry_id,
      })),
    );
    const catalog = setup({ getEntries });
    const keys = [pinKey(P1, 1), pinKey(P2, 2)];
    catalog.pins.set(keys, readableAll);
    await flush();
    expect(getEntries).toHaveBeenCalledTimes(1);
    expect(getEntries.mock.calls[0][0].items).toHaveLength(2);
    catalog.pins.set(keys, readableAll);
    expect(getEntries).toHaveBeenCalledTimes(1);
    catalog.pins.refresh();
    await flush();
    expect(getEntries).toHaveBeenCalledTimes(2);
    expect(getEntries.mock.calls[1][0].items).toHaveLength(2);
    clock += ACCOUNT_CATALOG.staleMs;
    catalog.pins.set(keys, readableAll);
    await flush();
    expect(getEntries.mock.calls[2][0].items).toHaveLength(2);
  });

  test("revoked without a pin-list change: hidden at once; restored: asked again", async () => {
    const getEntries = jest.fn(async ({ items }) =>
      items.map((ref) => ({
        ...entry(ref.project_id, 0),
        entry_id: ref.entry_id,
      })),
    );
    const catalog = setup({ getEntries });
    const keys = [pinKey(P1, 1), pinKey(P2, 2)];
    catalog.pins.set(keys, readableAll);
    await flush();
    catalog.pins.set(keys, (p) => p !== P2);
    expect(catalog.pins.get().pins.get(keys[1])).toBe("unavailable");
    expect(catalog.pins.get().pins.get(keys[0])).not.toBe("unavailable");
    await flush();
    expect(getEntries).toHaveBeenCalledTimes(1);
    catalog.pins.set(keys, readableAll);
    await flush();
    expect(getEntries).toHaveBeenCalledTimes(2);
    expect(getEntries.mock.calls[1][0].items).toEqual([pinEntryId(keys[1])]);
    expect(catalog.pins.get().pins.get(keys[1])).not.toBe("unavailable");
  });

  test("a refused batch: at most 8 projects asked once each; the rest unavailable", async () => {
    const keys = Array.from({ length: 100 }, (_, i) =>
      pinKey(`${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`, i),
    );
    const getEntries = jest.fn(async ({ items }) => {
      if (items.length > 1) throw Error("not found or not permitted");
      if (items[0].project_id.startsWith("00000003"))
        throw Error("not found or not permitted");
      return [
        { ...entry(items[0].project_id, 0), entry_id: items[0].entry_id },
      ];
    });
    const catalog = setup({ getEntries });
    catalog.pins.set(keys, readableAll);
    await flush();
    await flush();
    expect(getEntries).toHaveBeenCalledTimes(
      1 + ACCOUNT_CATALOG.maxPinFallbacks,
    );
    const values = keys.map((key) => catalog.pins.get().pins.get(key));
    expect(values.filter((v) => v !== "unavailable")).toHaveLength(7);
    expect(values.filter((v) => v === "unavailable")).toHaveLength(93);
  });

  test("a rate-limited or failed batch fans out to nothing and keeps what was shown", async () => {
    let fail = false;
    const getEntries = jest.fn(async ({ items }) => {
      if (fail)
        throw Error("artifact catalog read rate limit exceeded; retry later");
      return items.map((ref) => ({
        ...entry(ref.project_id, 0),
        entry_id: ref.entry_id,
      }));
    });
    const catalog = setup({ getEntries });
    const keys = [pinKey(P1, 1), pinKey(P2, 2)];
    catalog.pins.set(keys, readableAll);
    await flush();
    fail = true;
    catalog.pins.refresh();
    await flush();
    expect(getEntries).toHaveBeenCalledTimes(2);
    expect(catalog.pins.get().error).toContain("rate limit");
    expect(catalog.pins.get().pins.get(keys[0])).not.toBe("unavailable");
  });

  test("a late reply after a newer request is ignored", async () => {
    const replies: ((v: any) => void)[] = [];
    const getEntries = jest.fn(
      () => new Promise<any>((resolve) => replies.push(resolve)),
    );
    const catalog = setup({ getEntries });
    catalog.pins.set([pinKey(P1, 1)], readableAll);
    catalog.pins.set([pinKey(P2, 2)], readableAll);
    replies[1]([
      { ...entry(P2, 0), entry_id: pinEntryId(pinKey(P2, 2)).entry_id },
    ]);
    replies[0]([
      { ...entry(P1, 0), entry_id: pinEntryId(pinKey(P1, 1)).entry_id },
    ]);
    await flush();
    expect([...catalog.pins.get().pins.keys()]).toEqual([pinKey(P2, 2)]);
  });

  test("an invalid pin key is unavailable, without a crash or a call", async () => {
    const getEntries = jest.fn();
    const catalog = setup({ getEntries });
    catalog.pins.set(["not json"], readableAll);
    await flush();
    expect(catalog.pins.get().pins.get("not json")).toBe("unavailable");
    expect(getEntries).not.toHaveBeenCalled();
  });
});
