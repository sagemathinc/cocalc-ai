/** @jest-environment jsdom */

import {
  normalizeChatMessage,
  CURRENT_CHAT_MESSAGE_VERSION,
} from "../normalize";
import { handleSyncDBChange, initFromSyncDB } from "../sync";
import { Map as iMap } from "immutable";

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
      message_id: "m1",
      thread_id: "t1",
      history: [
        { content: "hi", author_id: "user-1", date: date.toISOString() },
      ],
      editing: {},
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
    const activityTs = store.state.activity?.get("t1");
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
      active_message_id: "msg-1",
      state: "running",
    };
    const syncdb = new MockSyncDB([threadState]);

    handleSyncDBChange({
      syncdb,
      store,
      changes: [
        { event: "chat-thread-state", sender_id: "__thread_state__", date },
      ],
    });
    expect(store.state.acpState?.get(`${date.valueOf()}`)).toBeUndefined();
    expect(store.state.acpState?.get("thread:thread-1")).toBe("running");
    expect(store.state.acpState?.get("message:msg-1")).toBe("running");
  });

  it("maps queued chat-row acp_state into acpState", () => {
    const store = new MockStore();
    const date = new Date("2024-01-02T03:04:05.000Z");
    const chatRecord = {
      event: "chat",
      sender_id: "user-1",
      date,
      message_id: "msg-queued-user",
      thread_id: "thread-queued-user",
      acp_state: "queued",
      history: [],
      editing: {},
      feedback: {},
      schema_version: CURRENT_CHAT_MESSAGE_VERSION,
    };
    const syncdb = new MockSyncDB([chatRecord]);

    handleSyncDBChange({
      syncdb,
      store,
      changes: [{ event: "chat", sender_id: "user-1", date }],
    });
    expect(store.state.acpState?.get("message:msg-queued-user")).toBe("queue");
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
        active_message_id: "msg-running",
        state: "running",
      },
      {
        event: "chat-thread-state",
        sender_id: "__thread_state__",
        date: queuedDate,
        thread_id: "thread-queued",
        active_message_id: "msg-queued",
        state: "queued",
      },
      {
        event: "chat-thread-state",
        sender_id: "__thread_state__",
        date: completeDate,
        thread_id: "thread-complete",
        active_message_id: "msg-complete",
        state: "complete",
      },
    ]);

    initFromSyncDB({ syncdb, store });
    expect(
      store.state.acpState?.get(`${runningDate.valueOf()}`),
    ).toBeUndefined();
    expect(
      store.state.acpState?.get(`${queuedDate.valueOf()}`),
    ).toBeUndefined();
    expect(
      store.state.acpState?.get(`${completeDate.valueOf()}`),
    ).toBeUndefined();
    expect(store.state.acpState?.get("thread:thread-running")).toBe("running");
    expect(store.state.acpState?.get("thread:thread-queued")).toBe("queue");
    expect(store.state.acpState?.get("thread:thread-complete")).toBeUndefined();
    expect(store.state.acpState?.get("message:msg-running")).toBe("running");
    expect(store.state.acpState?.get("message:msg-queued")).toBeUndefined();
    expect(store.state.acpState?.get("message:msg-complete")).toBeUndefined();
  });

  it("hydrates queued acp state from chat rows", () => {
    const store = new MockStore();
    const syncdb = new MockSyncDB([
      {
        event: "chat",
        sender_id: "user-1",
        date: "2024-01-02T03:04:05.000Z",
        message_id: "msg-user-queued",
        thread_id: "thread-queued",
        acp_state: "queued",
        history: [],
        editing: {},
        feedback: {},
        schema_version: CURRENT_CHAT_MESSAGE_VERSION,
      },
    ]);

    initFromSyncDB({ syncdb, store });
    expect(store.state.acpState?.get("message:msg-user-queued")).toBe("queue");
  });

  it("hydrates running acp state from chat rows", () => {
    const store = new MockStore();
    const syncdb = new MockSyncDB([
      {
        event: "chat-thread-state",
        sender_id: "__thread_state__",
        date: "2024-01-02T03:04:06.000Z",
        thread_id: "thread-running",
        active_message_id: "msg-user-running",
        state: "running",
      },
      {
        event: "chat",
        sender_id: "user-1",
        date: "2024-01-02T03:04:05.000Z",
        message_id: "msg-user-running",
        thread_id: "thread-running",
        acp_state: "running",
        history: [],
        editing: {},
        feedback: {},
        schema_version: CURRENT_CHAT_MESSAGE_VERSION,
      },
    ]);

    initFromSyncDB({ syncdb, store });
    expect(store.state.acpState?.get("message:msg-user-running")).toBe(
      "running",
    );
  });

  it("drops stale running chat-row state once thread-state no longer points at that message", () => {
    const store = new MockStore();
    const syncdb = new MockSyncDB([
      {
        event: "chat",
        sender_id: "user-1",
        date: "2024-01-02T03:04:05.000Z",
        message_id: "msg-user-running",
        thread_id: "thread-running",
        acp_state: "running",
        history: [],
        editing: {},
        feedback: {},
        schema_version: CURRENT_CHAT_MESSAGE_VERSION,
      },
      {
        event: "chat-thread-state",
        sender_id: "__thread_state__",
        date: "2024-01-02T03:04:06.000Z",
        thread_id: "thread-running",
        active_message_id: "msg-assistant-running",
        state: "running",
      },
    ]);

    initFromSyncDB({ syncdb, store });
    expect(
      store.state.acpState?.get("message:msg-user-running"),
    ).toBeUndefined();
    expect(store.state.acpState?.get("message:msg-assistant-running")).toBe(
      "running",
    );
  });

  it("removes stale running chat-row state when thread-state updates to a different active message", () => {
    const store = new MockStore();
    store.state.acpState = iMap().set("message:msg-user-running", "running");
    const syncdb = new MockSyncDB([
      {
        event: "chat",
        sender_id: "user-1",
        date: "2024-01-02T03:04:05.000Z",
        message_id: "msg-user-running",
        thread_id: "thread-running",
        acp_state: "running",
        history: [],
        editing: {},
        feedback: {},
        schema_version: CURRENT_CHAT_MESSAGE_VERSION,
      },
      {
        event: "chat-thread-state",
        sender_id: "__thread_state__",
        date: "2024-01-02T03:04:06.000Z",
        thread_id: "thread-running",
        active_message_id: "msg-assistant-running",
        state: "running",
      },
    ]);

    handleSyncDBChange({
      syncdb,
      store,
      changes: [
        {
          event: "chat-thread-state",
          sender_id: "__thread_state__",
          date: "2024-01-02T03:04:06.000Z",
        },
      ],
    });
    expect(store.state.acpState?.get("message:msg-user-running")).toBe(
      undefined,
    );
    expect(store.state.acpState?.get("message:msg-assistant-running")).toBe(
      "running",
    );
  });
});
