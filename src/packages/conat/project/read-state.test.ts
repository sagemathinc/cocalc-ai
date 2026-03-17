import {
  createProjectReadStateStore,
  getProjectReadStateStoreName,
  mergeProjectReadStateEntries,
  type ProjectReadStateEntry,
} from "./read-state";

class FakeKV {
  private data: Record<string, ProjectReadStateEntry> = {};

  get(key?: string) {
    if (key == null) {
      return this.getAll();
    }
    return this.data[key];
  }

  getAll() {
    return { ...this.data };
  }

  set(key: string, value: ProjectReadStateEntry) {
    this.data[key] = value;
  }

  delete(key: string) {
    delete this.data[key];
  }

  close() {}
}

describe("project read state", () => {
  it("names the store by account within the project-scoped DKV", () => {
    expect(
      getProjectReadStateStoreName("00000000-1000-4000-8000-000000000001"),
    ).toBe("project-read-state-v1-00000000-1000-4000-8000-000000000001");
  });

  it("stores chat watermarks per path and thread", () => {
    const store = createProjectReadStateStore({
      account_id: "a",
      project_id: "p",
      store: new FakeKV(),
    });

    const at = new Date("2026-03-17T12:00:00.000Z");
    const entry = store.touchChatThread("/tmp/a.chat", "thread-1", {
      message_id: "msg-1",
      at,
    });

    expect(entry).toEqual({
      kind: "chat",
      threads: {
        "thread-1": { m: "msg-1", t: at },
      },
    });
    expect(store.getChatThread("/tmp/a.chat", "thread-1")).toEqual({
      m: "msg-1",
      t: at,
    });
  });

  it("does not regress a chat watermark when given an older timestamp", () => {
    const store = createProjectReadStateStore({
      account_id: "a",
      project_id: "p",
      store: new FakeKV(),
    });

    store.touchChatThread("/tmp/a.chat", "thread-1", {
      message_id: "msg-new",
      at: new Date("2026-03-17T12:00:05.000Z"),
    });
    store.touchChatThread("/tmp/a.chat", "thread-1", {
      message_id: "msg-old",
      at: new Date("2026-03-17T12:00:01.000Z"),
    });

    expect(store.getChatThread("/tmp/a.chat", "thread-1")).toEqual({
      m: "msg-new",
      t: new Date("2026-03-17T12:00:05.000Z"),
    });
  });

  it("lists recent paths by their newest per-entry watermark", () => {
    const store = createProjectReadStateStore({
      account_id: "a",
      project_id: "p",
      store: new FakeKV(),
    });

    store.touchChatThread("/tmp/older.chat", "thread-1", {
      message_id: "msg-1",
      at: new Date("2026-03-17T12:00:01.000Z"),
    });
    store.touchChatThread("/tmp/newer.chat", "thread-2", {
      message_id: "msg-2",
      at: new Date("2026-03-17T12:00:09.000Z"),
    });
    store.touchChatThread("/tmp/newer.chat", "thread-3", {
      message_id: "msg-3",
      at: new Date("2026-03-17T12:00:10.000Z"),
    });

    expect(store.listRecent({ limit: 2 })).toEqual([
      {
        path: "/tmp/newer.chat",
        t: new Date("2026-03-17T12:00:10.000Z"),
        value: {
          kind: "chat",
          threads: {
            "thread-2": {
              m: "msg-2",
              t: new Date("2026-03-17T12:00:09.000Z"),
            },
            "thread-3": {
              m: "msg-3",
              t: new Date("2026-03-17T12:00:10.000Z"),
            },
          },
        },
      },
      {
        path: "/tmp/older.chat",
        t: new Date("2026-03-17T12:00:01.000Z"),
        value: {
          kind: "chat",
          threads: {
            "thread-1": {
              m: "msg-1",
              t: new Date("2026-03-17T12:00:01.000Z"),
            },
          },
        },
      },
    ]);
  });

  it("merges concurrent chat thread updates by keeping the newest thread watermark", () => {
    expect(
      mergeProjectReadStateEntries(
        {
          kind: "chat",
          threads: {
            "thread-1": {
              m: "local-newer",
              t: new Date("2026-03-17T12:00:10.000Z"),
            },
            "thread-2": {
              m: "local-only",
              t: new Date("2026-03-17T12:00:02.000Z"),
            },
          },
        },
        {
          kind: "chat",
          threads: {
            "thread-1": {
              m: "remote-older",
              t: new Date("2026-03-17T12:00:03.000Z"),
            },
            "thread-3": {
              m: "remote-only",
              t: new Date("2026-03-17T12:00:04.000Z"),
            },
          },
        },
      ),
    ).toEqual({
      kind: "chat",
      threads: {
        "thread-1": {
          m: "local-newer",
          t: new Date("2026-03-17T12:00:10.000Z"),
        },
        "thread-2": {
          m: "local-only",
          t: new Date("2026-03-17T12:00:02.000Z"),
        },
        "thread-3": {
          m: "remote-only",
          t: new Date("2026-03-17T12:00:04.000Z"),
        },
      },
    });
  });
});
