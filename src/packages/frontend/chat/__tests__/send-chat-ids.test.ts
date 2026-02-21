/** @jest-environment jsdom */

import { ChatActions } from "../actions";
import { webapp_client } from "@cocalc/frontend/webapp-client";

jest.mock("@cocalc/frontend/user-tracking", () => ({
  __esModule: true,
  default: jest.fn(),
}));

function makeActions(messages: Map<string, any> = new Map()): any {
  const actions: any = new (ChatActions as any)("proj-1", "x.chat");
  const syncdb = {
    set: jest.fn(),
    commit: jest.fn(),
    get_one: jest.fn().mockReturnValue(undefined),
    delete: jest.fn(),
    save: jest.fn(),
  };
  actions.syncdb = syncdb;
  actions.store = {
    get: (key: string) =>
      key === "project_id" ? "proj-1" : key === "path" ? "x.chat" : undefined,
  };
  actions.redux = {
    getStore: (name: string) =>
      name === "account"
        ? {
            get_account_id: () => "00000000-1000-4000-8000-000000000001",
          }
        : undefined,
  };
  actions.messageCache = {
    getMessages: () => messages,
    getThreadIndex: () => new Map(),
    getByMessageId: () => undefined,
    getMessageIdIndex: () => new Map(),
    getByDateKey: (key: string) => messages.get(key),
  };
  actions.deleteDraft = jest.fn();
  actions.clearAllFilters = jest.fn();
  actions.setSelectedThread = jest.fn();
  actions.renameThread = jest.fn().mockReturnValue(true);
  actions.toggleFoldThread = jest.fn();
  actions.processLLM = jest.fn().mockResolvedValue(undefined);
  actions.isLanguageModelThread = jest.fn().mockReturnValue(false);
  return actions;
}

describe("sendChat identity fields", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .spyOn(webapp_client as any, "server_time")
      .mockReturnValue(new Date("2026-02-21T18:00:00.000Z"));
    jest
      .spyOn(webapp_client as any, "mark_file")
      .mockImplementation(async () => {});
  });

  it("writes root messages with message_id/thread_id and thread-config with same thread_id", async () => {
    const actions = makeActions();
    actions.sendChat({ input: "hello world" });
    await Promise.resolve();

    const chatSet = actions.syncdb.set.mock.calls
      .map((x) => x[0])
      .find((row: any) => row?.event === "chat" && row?.history?.[0]?.content === "hello world");
    expect(chatSet).toBeTruthy();
    expect(typeof chatSet.message_id).toBe("string");
    expect(chatSet.message_id.length).toBeGreaterThan(0);
    expect(typeof chatSet.thread_id).toBe("string");
    expect(chatSet.thread_id.length).toBeGreaterThan(0);

    const cfgSet = actions.syncdb.set.mock.calls
      .map((x) => x[0])
      .find((row: any) => row?.event === "chat-thread-config");
    expect(cfgSet).toBeTruthy();
    expect(cfgSet.thread_id).toBe(chatSet.thread_id);
  });

  it("writes reply messages with inherited thread_id and reply_to_message_id", async () => {
    const rootDate = new Date("2026-02-21T17:59:00.000Z");
    const rootIso = rootDate.toISOString();
    const rootMs = rootDate.valueOf();
    const messages = new Map<string, any>([
      [
        `${rootMs}`,
        {
          event: "chat",
          sender_id: "00000000-1000-4000-8000-000000000001",
          date: rootDate,
          message_id: "root-msg-1",
          thread_id: "thread-abc-1",
          history: [
            {
              author_id: "00000000-1000-4000-8000-000000000001",
              content: "root",
              date: rootIso,
            },
          ],
        },
      ],
    ]);
    (webapp_client.server_time as any).mockReturnValue(
      new Date("2026-02-21T18:01:00.000Z"),
    );
    const actions = makeActions(messages);

    actions.sendChat({
      input: "reply content",
      reply_to: rootDate,
    });
    await Promise.resolve();

    const replySet = actions.syncdb.set.mock.calls
      .map((x) => x[0])
      .find((row: any) => row?.event === "chat" && row?.history?.[0]?.content === "reply content");
    expect(replySet).toBeTruthy();
    expect(replySet.thread_id).toBe("thread-abc-1");
    expect(replySet.reply_to_message_id).toBe("root-msg-1");
    expect(typeof replySet.message_id).toBe("string");
    expect(replySet.message_id.length).toBeGreaterThan(0);
  });
});

describe("thread-config by thread_id", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .spyOn(webapp_client as any, "server_time")
      .mockReturnValue(new Date("2026-02-21T18:00:00.000Z"));
    jest
      .spyOn(webapp_client as any, "mark_file")
      .mockImplementation(async () => {});
  });

  it("reads thread metadata from thread-config using explicit thread_id", () => {
    const threadId = "11111111-1111-4111-8111-111111111111";
    const actions = makeActions();
    actions.syncdb.get_one.mockImplementation((where: any) => {
      if (where?.event === "chat-thread-config" && where?.thread_id === threadId) {
        return {
          event: "chat-thread-config",
          sender_id: "__thread_config__",
          date: "2026-02-21T18:00:00.000Z",
          thread_id: threadId,
          name: "  Thread Name  ",
          thread_color: "#ff9800",
          thread_icon: "thumbs-up",
          thread_image: "https://example.com/x.png",
          pin: "true",
          acp_config: { model: "gpt-5.3-codex" },
        };
      }
      return undefined;
    });

    const meta = actions.getThreadMetadata("not-a-date-key", { threadId });
    expect(meta.name).toBe("Thread Name");
    expect(meta.thread_color).toBe("#ff9800");
    expect(meta.thread_icon).toBe("thumbs-up");
    expect(meta.thread_image).toBe("https://example.com/x.png");
    expect(meta.pin).toBe(true);
    expect(meta.agent_kind).toBe("acp");
    expect(meta.agent_mode).toBe("interactive");
    expect(meta.agent_model).toBe("gpt-5.3-codex");
  });

  it("updates thread-config by UUID thread key without timestamp keying", () => {
    const threadId = "22222222-2222-4222-8222-222222222222";
    const existing = {
      event: "chat-thread-config",
      sender_id: "__thread_config__",
      date: "2026-02-21T18:30:00.000Z",
      thread_id: threadId,
      name: "Before",
    };
    const actions = makeActions();
    actions.syncdb.get_one.mockImplementation((where: any) => {
      if (where?.event === "chat-thread-config" && where?.thread_id === threadId) {
        return existing;
      }
      return undefined;
    });

    const ok = actions.setThreadAppearance(threadId, { name: "After" });
    expect(ok).toBe(true);
    expect(actions.syncdb.commit).toHaveBeenCalled();
    const setRow = actions.syncdb.set.mock.calls
      .map((x) => x[0])
      .find((row: any) => row?.event === "chat-thread-config" && row?.thread_id === threadId);
    expect(setRow).toBeTruthy();
    expect(setRow.date).toBe("2026-02-21T18:30:00.000Z");
    expect(setRow.name).toBe("After");
  });

  it("persists appearance and pin settings for UUID thread keys", () => {
    const threadId = "33333333-3333-4333-8333-333333333333";
    const existing = {
      event: "chat-thread-config",
      sender_id: "__thread_config__",
      date: "2026-02-21T18:40:00.000Z",
      thread_id: threadId,
      name: "Thread",
    };
    const actions = makeActions();
    actions.syncdb.get_one.mockImplementation((where: any) => {
      if (where?.event === "chat-thread-config" && where?.thread_id === threadId) {
        return existing;
      }
      return undefined;
    });

    expect(
      actions.setThreadAppearance(threadId, {
        color: "#ff9800",
        icon: "thumbs-up",
        image: "https://example.com/img.png",
      }),
    ).toBe(true);
    expect(actions.setThreadPin(threadId, true)).toBe(true);

    const rows = actions.syncdb.set.mock.calls.map((x) => x[0]);
    const appearance = rows.find(
      (row: any) =>
        row?.event === "chat-thread-config" &&
        row?.thread_id === threadId &&
        row?.thread_color === "#ff9800",
    );
    const pin = rows.find(
      (row: any) =>
        row?.event === "chat-thread-config" &&
        row?.thread_id === threadId &&
        row?.pin === true,
    );
    expect(appearance?.thread_icon).toBe("thumbs-up");
    expect(appearance?.thread_image).toBe("https://example.com/img.png");
    expect(pin).toBeTruthy();
  });
});

describe("deleteThread identity targeting", () => {
  it("deletes by UUID thread_id and removes thread config/state rows", () => {
    const threadA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const threadB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const d1 = new Date("2026-02-21T19:00:00.000Z");
    const d2 = new Date("2026-02-21T19:01:00.000Z");
    const d3 = new Date("2026-02-21T19:02:00.000Z");
    const messages = new Map<string, any>([
      [
        `${d1.valueOf()}`,
        {
          event: "chat",
          sender_id: "u1",
          date: d1,
          thread_id: threadA,
          message_id: "m1",
          history: [],
        },
      ],
      [
        `${d2.valueOf()}`,
        {
          event: "chat",
          sender_id: "u1",
          date: d2,
          thread_id: threadA,
          message_id: "m2",
          reply_to: d1.toISOString(),
          history: [],
        },
      ],
      [
        `${d3.valueOf()}`,
        {
          event: "chat",
          sender_id: "u2",
          date: d3,
          thread_id: threadB,
          message_id: "m3",
          history: [],
        },
      ],
    ]);
    const actions = makeActions(messages);
    const deleted = actions.deleteThread(threadA);
    expect(deleted).toBe(2);
    expect(actions.syncdb.commit).toHaveBeenCalled();

    const deletes = actions.syncdb.delete.mock.calls.map((x) => x[0]);
    const chatDeletes = deletes.filter((row: any) => row?.event === "chat");
    expect(chatDeletes).toHaveLength(2);
    expect(
      deletes.find(
        (row: any) =>
          row?.event === "chat-thread-config" && row?.thread_id === threadA,
      ),
    ).toBeTruthy();
    expect(
      deletes.find(
        (row: any) => row?.event === "chat-thread-state" && row?.thread_id === threadA,
      ),
    ).toBeTruthy();
  });

  it("keeps timestamp-key delete compatibility", () => {
    const thread = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const root = new Date("2026-02-21T20:00:00.000Z");
    const reply = new Date("2026-02-21T20:01:00.000Z");
    const other = new Date("2026-02-21T20:02:00.000Z");
    const messages = new Map<string, any>([
      [
        `${root.valueOf()}`,
        {
          event: "chat",
          sender_id: "u1",
          date: root,
          thread_id: thread,
          message_id: "root",
          history: [],
        },
      ],
      [
        `${reply.valueOf()}`,
        {
          event: "chat",
          sender_id: "u1",
          date: reply,
          thread_id: thread,
          message_id: "reply",
          reply_to: root.toISOString(),
          history: [],
        },
      ],
      [
        `${other.valueOf()}`,
        {
          event: "chat",
          sender_id: "u2",
          date: other,
          thread_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          message_id: "other",
          history: [],
        },
      ],
    ]);
    const actions = makeActions(messages);
    const deleted = actions.deleteThread(`${root.valueOf()}`);
    expect(deleted).toBe(2);
    const chatDeletes = actions.syncdb.delete.mock.calls
      .map((x) => x[0])
      .filter((row: any) => row?.event === "chat");
    expect(chatDeletes).toHaveLength(2);
  });
});
