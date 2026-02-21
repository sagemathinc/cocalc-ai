/** @jest-environment jsdom */

import { EventEmitter } from "events";
import { ChatMessageCache } from "../message-cache";

class MockSyncdb extends EventEmitter {
  public opts = { ignoreInitialChanges: true };
  private rows: any[];

  constructor(rows: any[]) {
    super();
    this.rows = rows;
  }

  get_state() {
    return "ready";
  }

  get() {
    return this.rows;
  }

  get_one(where: Record<string, unknown>) {
    return this.rows.find((row) =>
      Object.entries(where).every(([k, v]) => row[k] === v),
    );
  }

  replaceRows(rows: any[]) {
    this.rows = rows;
  }
}

describe("ChatMessageCache message_id index", () => {
  it("indexes messages by message_id and updates on change events", async () => {
    const rows = [
      {
        event: "chat",
        sender_id: "user-1",
        date: "2026-01-01T00:00:00.000Z",
        message_id: "msg-1",
        history: [],
      },
      {
        event: "chat",
        sender_id: "user-2",
        date: "2026-01-01T00:00:01.000Z",
        message_id: "msg-2",
        history: [],
      },
    ];
    const syncdb = new MockSyncdb(rows);
    const cache = new ChatMessageCache(syncdb as any);

    // allow async rebuild to finish
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cache.getByMessageId("msg-1")?.sender_id).toBe("user-1");
    expect(cache.getByMessageId("msg-2")?.sender_id).toBe("user-2");
    expect(cache.getMessagesById().get("msg-1")?.sender_id).toBe("user-1");
    expect(cache.getDateIndex().get(`${new Date(rows[0].date).valueOf()}`)).toBe(
      "msg-1",
    );

    const updated = {
      event: "chat",
      sender_id: "user-2",
      date: "2026-01-01T00:00:01.000Z",
      message_id: "msg-2b",
      history: [],
    };
    syncdb.replaceRows([rows[0], updated]);
    syncdb.emit("change", new Set([updated]));

    expect(cache.getByMessageId("msg-2")).toBeUndefined();
    expect(cache.getByMessageId("msg-2b")?.sender_id).toBe("user-2");
    expect(cache.getMessagesById().has("msg-2")).toBe(false);
    cache.dispose();
  });

  it("maintains thread index counts when replies are added/removed", async () => {
    const rootDate = "2026-01-01T00:00:00.000Z";
    const replyDate = "2026-01-01T00:00:01.000Z";
    const rows = [
      {
        event: "chat",
        sender_id: "user-1",
        date: rootDate,
        message_id: "root-1",
        thread_id: "thread-1",
        history: [],
      },
      {
        event: "chat",
        sender_id: "user-2",
        date: replyDate,
        message_id: "reply-1",
        thread_id: "thread-1",
        reply_to: rootDate,
        reply_to_message_id: "root-1",
        history: [],
      },
    ];
    const syncdb = new MockSyncdb(rows);
    const cache = new ChatMessageCache(syncdb as any);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const threadKey = `${new Date(rootDate).valueOf()}`;
    const entry = cache.getThreadIndex().get(threadKey);
    expect(entry?.messageCount).toBe(2);

    // Remove reply row and emit a change for that PK.
    syncdb.replaceRows([rows[0]]);
    syncdb.emit("change", new Set([rows[1]]));
    const entryAfter = cache.getThreadIndex().get(threadKey);
    expect(entryAfter?.messageCount).toBe(1);
    cache.dispose();
  });

  it("groups replies by thread_id even if reply_to is stale", async () => {
    const rootDate = "2026-01-03T00:00:00.000Z";
    const staleReplyTarget = "2026-01-01T00:00:00.000Z";
    const replyDate = "2026-01-03T00:00:01.000Z";
    const rows = [
      {
        event: "chat",
        sender_id: "user-1",
        date: rootDate,
        message_id: "root-thread-2",
        thread_id: "thread-2",
        history: [],
      },
      {
        event: "chat",
        sender_id: "user-2",
        date: replyDate,
        message_id: "reply-thread-2",
        thread_id: "thread-2",
        // Intentionally stale/incorrect; grouping should still follow thread_id.
        reply_to: staleReplyTarget,
        history: [],
      },
    ];
    const syncdb = new MockSyncdb(rows);
    const cache = new ChatMessageCache(syncdb as any);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const rootKey = `${new Date(rootDate).valueOf()}`;
    const entry = cache.getThreadIndex().get(rootKey);
    expect(entry?.messageCount).toBe(2);
    const staleKey = `${new Date(staleReplyTarget).valueOf()}`;
    expect(cache.getThreadIndex().get(staleKey)).toBeUndefined();
    expect(cache.getThreadKeyByThreadId("thread-2")).toBe(rootKey);
    expect(cache.getThreadKeyByThreadId(" thread-2 ")).toBe(rootKey);
    cache.dispose();
  });

  it("drops thread_id mapping when the thread root is removed", async () => {
    const rootDate = "2026-01-04T00:00:00.000Z";
    const rows = [
      {
        event: "chat",
        sender_id: "user-1",
        date: rootDate,
        message_id: "root-thread-3",
        thread_id: "thread-3",
        history: [],
      },
    ];
    const syncdb = new MockSyncdb(rows);
    const cache = new ChatMessageCache(syncdb as any);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cache.getThreadKeyByThreadId("thread-3")).toBe(
      `${new Date(rootDate).valueOf()}`,
    );

    syncdb.replaceRows([]);
    syncdb.emit("change", new Set([rows[0]]));

    expect(cache.getThreadKeyByThreadId("thread-3")).toBeUndefined();
    cache.dispose();
  });
});
