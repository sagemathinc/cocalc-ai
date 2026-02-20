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
    cache.dispose();
  });
});

