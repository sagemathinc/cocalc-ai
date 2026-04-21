import {
  BrowserOutboxStore,
  MemoryBrowserOutboxBackend,
} from "../browser-outbox";

describe("BrowserOutboxStore", () => {
  it("stores, lists, leases, and removes entries", async () => {
    const store = new BrowserOutboxStore({
      backend: new MemoryBrowserOutboxBackend(),
    });
    const entry = await store.put({
      id: "entry-1",
      kind: "chat-row",
      op: "chat-row",
      project_id: "project-1",
      path: "x.chat",
      payload: { input: "hello" },
    });

    expect(entry?.id).toBe("entry-1");
    expect(
      await store.list({ kind: "chat-row", project_id: "project-1" }),
    ).toHaveLength(1);

    const lease = await store.acquireLease({
      id: "entry-1",
      owner: "tab-1",
      ttlMs: 10_000,
    });
    expect(lease?.lease_owner).toBe("tab-1");
    await expect(
      store.acquireLease({ id: "entry-1", owner: "tab-2" }),
    ).resolves.toBeUndefined();

    await store.remove("entry-1");
    expect(await store.list()).toHaveLength(0);
  });

  it("expires old entries", async () => {
    const now = Date.now();
    const store = new BrowserOutboxStore({
      backend: new MemoryBrowserOutboxBackend(),
    });
    await store.put({
      id: "expired",
      kind: "chat-row",
      op: "chat-row",
      created_at: now - 10_000,
      expires_at: now - 1,
      payload: { input: "old" },
    });
    await store.put({
      id: "fresh",
      kind: "chat-row",
      op: "chat-row",
      payload: { input: "new" },
    });

    expect((await store.list()).map((entry) => entry.id)).toEqual(["fresh"]);
  });

  it("enforces entry and total byte caps", async () => {
    const store = new BrowserOutboxStore({
      backend: new MemoryBrowserOutboxBackend(),
      limits: {
        maxEntryBytes: 2000,
        maxTotalBytes: 750,
        maxEntries: 1,
      },
    });

    await expect(
      store.put({
        id: "too-large",
        kind: "chat-row",
        op: "chat-row",
        payload: { input: "x".repeat(2500) },
      }),
    ).resolves.toBeUndefined();

    await store.put({
      id: "old",
      kind: "chat-row",
      op: "chat-row",
      created_at: 1,
      payload: { input: "a".repeat(300) },
    });
    await store.put({
      id: "new",
      kind: "chat-row",
      op: "chat-row",
      created_at: 2,
      payload: { input: "b".repeat(300) },
    });

    expect((await store.list()).map((entry) => entry.id)).toEqual(["new"]);
  });
});
