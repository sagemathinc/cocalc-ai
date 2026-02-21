/** @jest-environment jsdom */

import {
  normalizeChatMessage,
  CURRENT_CHAT_MESSAGE_VERSION,
} from "../normalize";
import { handleSyncDBChange, initFromSyncDB } from "../sync";

class MockStore {
  state: any = {};
  setState(update: any) {
    this.state = { ...this.state, ...update };
  }
  get(key: string) {
    return this.state[key];
  }
}

class MockSyncDB {
  constructor(private records: any[]) {}
  get() {
    return this.records;
  }
  get_one(where: any) {
    return this.records.find((r) =>
      Object.entries(where).every(([k, v]) => r[k] === v),
    );
  }
}

describe("normalizeChatMessage", () => {
  it("converts date, builds history, and does not mutate input", () => {
    const raw = {
      event: "chat",
      sender_id: "user-1",
      date: "2024-01-02T03:04:05.000Z",
      payload: { content: "hello" },
    };
    const { message, upgraded } = normalizeChatMessage(raw);

    expect(upgraded).toBe(true);
    expect(message?.date instanceof Date).toBe(true);
    expect(message?.history?.length).toBe(1);
    expect(message?.history?.[0]?.content).toBe("hello");
    expect(message?.schema_version).toBe(CURRENT_CHAT_MESSAGE_VERSION);
    expect(message?.message_id).toMatch(/^legacy-message-/);
    expect(message?.thread_id).toMatch(/^legacy-thread-/);
    // original object should remain untouched
    expect(raw.payload?.content).toBe("hello");
  });

  it("adds missing ids even when schema_version is already current", () => {
    const raw = {
      event: "chat",
      sender_id: "user-1",
      date: "2024-01-02T03:04:05.000Z",
      schema_version: CURRENT_CHAT_MESSAGE_VERSION,
      history: [],
      editing: {},
      folding: [],
      feedback: {},
    };
    const { message, upgraded } = normalizeChatMessage(raw);
    expect(upgraded).toBe(true);
    expect(message?.message_id).toMatch(/^legacy-message-/);
    expect(message?.thread_id).toMatch(/^legacy-thread-/);
  });
});

describe("handleSyncDBChange", () => {
  it("applies chat and draft changes into the store", () => {
    const store = new MockStore();
    // Pretend initial replay is complete so activity updates run
    store.state.activityReady = true;

    const date = new Date("2024-01-02T03:04:05.000Z");
    const messagesRecord = {
      event: "chat",
      sender_id: "user-1",
      date,
      history: [
        { content: "hi", author_id: "user-1", date: date.toISOString() },
      ],
      editing: {},
      folding: [],
      feedback: {},
      schema_version: CURRENT_CHAT_MESSAGE_VERSION,
    };
    const draftRecord = {
      event: "draft",
      sender_id: "user-1",
      date,
      input: "draft text",
      active: Date.now(),
    };
    const syncdb = new MockSyncDB([messagesRecord, draftRecord]);

    // chat change
    handleSyncDBChange({
      syncdb,
      store,
      changes: [{ event: "chat", sender_id: "user-1", date }],
    });
    const activityTs = store.state.activity?.get(`${date.valueOf()}`);
    expect(typeof activityTs).toBe("number");

    // draft change
    handleSyncDBChange({
      syncdb,
      store,
      changes: [{ event: "draft", sender_id: "user-1", date }],
    });
    const draftKey = `${draftRecord.sender_id}:${draftRecord.date}`;
    expect(store.state.drafts?.get(draftKey)?.input).toBe("draft text");
  });

  it("maps thread-state records into acpState", () => {
    const store = new MockStore();
    const date = new Date("2024-01-02T03:04:05.000Z");
    const threadState = {
      event: "chat-thread-state",
      sender_id: "__thread_state__",
      date,
      thread_id: "thread-1",
      state: "running",
    };
    const syncdb = new MockSyncDB([threadState]);

    handleSyncDBChange({
      syncdb,
      store,
      changes: [{ event: "chat-thread-state", sender_id: "__thread_state__", date }],
    });
    expect(store.state.acpState?.get(`${date.valueOf()}`)).toBe("running");
    expect(store.state.acpState?.get("thread:thread-1")).toBe("running");
  });
});

describe("initFromSyncDB", () => {
  it("hydrates acpState from persisted thread-state rows", () => {
    const store = new MockStore();
    const runningDate = new Date("2024-01-02T03:04:05.000Z");
    const queuedDate = new Date("2024-01-03T03:04:05.000Z");
    const completeDate = new Date("2024-01-04T03:04:05.000Z");
    const syncdb = new MockSyncDB([
      {
        event: "chat-thread-state",
        sender_id: "__thread_state__",
        date: runningDate,
        thread_id: "thread-running",
        state: "running",
      },
      {
        event: "chat-thread-state",
        sender_id: "__thread_state__",
        date: queuedDate,
        thread_id: "thread-queued",
        state: "queued",
      },
      {
        event: "chat-thread-state",
        sender_id: "__thread_state__",
        date: completeDate,
        thread_id: "thread-complete",
        state: "complete",
      },
    ]);

    initFromSyncDB({ syncdb, store });
    expect(store.state.acpState?.get(`${runningDate.valueOf()}`)).toBe("running");
    expect(store.state.acpState?.get(`${queuedDate.valueOf()}`)).toBe("queue");
    expect(store.state.acpState?.get(`${completeDate.valueOf()}`)).toBeUndefined();
    expect(store.state.acpState?.get("thread:thread-running")).toBe("running");
    expect(store.state.acpState?.get("thread:thread-queued")).toBe("queue");
    expect(store.state.acpState?.get("thread:thread-complete")).toBeUndefined();
  });
});
