/** @jest-environment jsdom */

import { CHAT_THREAD_META_ROW_DATE } from "@cocalc/chat";
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
    getByMessageId: (messageId: string) => {
      const trimmed = `${messageId ?? ""}`.trim();
      if (!trimmed) return undefined;
      for (const msg of messages.values()) {
        if (`${msg?.message_id ?? ""}`.trim() === trimmed) {
          return msg;
        }
      }
      return undefined;
    },
    getMessageIdIndex: () => {
      const index = new Map<string, string>();
      for (const [key, msg] of messages) {
        const messageId = `${msg?.message_id ?? ""}`.trim();
        if (messageId) {
          index.set(messageId, key);
        }
      }
      return index;
    },
    getByDateKey: (key: string) => messages.get(key),
    getThreadKeyByThreadId: (threadId: string) => {
      const trimmed = `${threadId ?? ""}`.trim();
      if (!trimmed) return undefined;
      let fallbackKey: string | undefined;
      for (const [key, msg] of messages) {
        if (`${msg?.thread_id ?? ""}`.trim() !== trimmed) continue;
        if (msg?.reply_to == null) return key;
        if (!fallbackKey) fallbackKey = key;
      }
      return fallbackKey;
    },
  };
  actions.deleteDraft = jest.fn();
  actions.clearAllFilters = jest.fn();
  actions.setSelectedThread = jest.fn();
  actions.renameThread = jest.fn().mockReturnValue(true);
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
      .find(
        (row: any) =>
          row?.event === "chat" && row?.history?.[0]?.content === "hello world",
      );
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

  it("bumps send timestamp when the proposed millisecond already exists", async () => {
    const baseDate = new Date("2026-02-21T18:00:00.000Z");
    const baseMs = baseDate.valueOf();
    const messages = new Map<string, any>([
      [
        `${baseMs}`,
        {
          event: "chat",
          sender_id: "00000000-1000-4000-8000-000000000001",
          date: baseDate.toISOString(),
          message_id: "existing-msg",
          thread_id: "existing-thread",
          history: [],
        },
      ],
    ]);
    (webapp_client.server_time as any).mockReturnValue(baseDate);
    const actions = makeActions(messages);

    actions.sendChat({ input: "collision check" });
    await Promise.resolve();

    const chatSet = actions.syncdb.set.mock.calls
      .map((x) => x[0])
      .find(
        (row: any) =>
          row?.event === "chat" &&
          row?.history?.[0]?.content === "collision check",
      );
    expect(chatSet).toBeTruthy();
    const writtenMs = new Date(chatSet.date).valueOf();
    expect(writtenMs).toBe(baseMs + 1);
  });

  it("writes new-thread codex config and appearance in the initial thread-config row", async () => {
    const actions = makeActions();

    actions.sendChat({
      input: "launch codex",
      name: "Configured thread",
      threadAgent: {
        mode: "codex",
        model: "gpt-5.4",
        codexConfig: {
          model: "gpt-5.4",
          sessionMode: "workspace-write",
          reasoning: "high",
        } as any,
      },
      threadAppearance: {
        color: "#123456",
        icon: "rocket",
        image: "https://example.com/thread.png",
      },
    });
    await Promise.resolve();

    const rows = actions.syncdb.set.mock.calls.map((x) => x[0]);
    const chatSet = rows.find(
      (row: any) =>
        row?.event === "chat" && row?.history?.[0]?.content === "launch codex",
    );
    const cfgSet = rows.find(
      (row: any) =>
        row?.event === "chat-thread-config" &&
        row?.thread_id === chatSet?.thread_id,
    );

    expect(chatSet).toBeTruthy();
    expect(cfgSet).toBeTruthy();
    expect(cfgSet.name).toBe("Configured thread");
    expect(cfgSet.thread_color).toBe("#123456");
    expect(cfgSet.thread_icon).toBe("rocket");
    expect(cfgSet.thread_image).toBe("https://example.com/thread.png");
    expect(cfgSet.agent_kind).toBe("acp");
    expect(cfgSet.agent_mode).toBe("interactive");
    expect(cfgSet.agent_model).toBe("gpt-5.4");
    expect(cfgSet.acp_config).toEqual(
      expect.objectContaining({
        model: "gpt-5.4",
        sessionMode: "workspace-write",
        reasoning: "high",
        allowWrite: true,
      }),
    );
  });

  it("creates config-only threads without requiring an initial message", async () => {
    const actions = makeActions();

    const threadId = actions.createEmptyThread({
      name: "Automation thread",
      threadAgent: {
        mode: "codex",
        model: "gpt-5.4",
        codexConfig: {
          model: "gpt-5.4",
          sessionMode: "workspace-write",
          reasoning: "high",
        } as any,
      },
      threadAppearance: {
        color: "#123456",
        icon: "robot",
        image: "https://example.com/thread.png",
      },
    });
    await Promise.resolve();

    expect(threadId).toBeTruthy();
    const rows = actions.syncdb.set.mock.calls.map((x) => x[0]);
    expect(rows.find((row: any) => row?.event === "chat")).toBeUndefined();

    const cfgSet = rows.find(
      (row: any) =>
        row?.event === "chat-thread-config" && row?.thread_id === threadId,
    );
    expect(cfgSet).toBeTruthy();
    expect(cfgSet.name).toBe("Automation thread");
    expect(cfgSet.thread_color).toBe("#123456");
    expect(cfgSet.thread_icon).toBe("robot");
    expect(cfgSet.thread_image).toBe("https://example.com/thread.png");
    expect(cfgSet.agent_kind).toBe("acp");
    expect(cfgSet.agent_mode).toBe("interactive");
    expect(cfgSet.agent_model).toBe("gpt-5.4");
    expect(cfgSet.acp_config).toEqual(
      expect.objectContaining({
        model: "gpt-5.4",
        sessionMode: "workspace-write",
        reasoning: "high",
        allowWrite: true,
      }),
    );
    expect(actions.clearAllFilters).toHaveBeenCalled();
    expect(actions.setSelectedThread).toHaveBeenCalledWith(threadId);
    expect(actions.syncdb.commit).toHaveBeenCalled();
  });

  it("passes normalized new-thread codex config directly to ACP dispatch", async () => {
    const actions = makeActions();

    actions.sendChat({
      input: "launch codex",
      threadAgent: {
        mode: "codex",
        model: "gpt-5.3-codex-spark",
        codexConfig: {
          model: "gpt-5.3-codex-spark",
          sessionMode: "full-access",
          reasoning: "extra_high",
        } as any,
      },
    });
    await Promise.resolve();

    expect(actions.processLLM).toHaveBeenCalledWith(
      expect.objectContaining({
        acpConfigOverride: expect.objectContaining({
          model: "gpt-5.3-codex-spark",
          sessionMode: "full-access",
          reasoning: "extra_high",
          allowWrite: true,
        }),
      }),
    );
  });

  it("writes reply messages with inherited thread_id and parent_message_id", async () => {
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
      reply_thread_id: "thread-abc-1",
    });
    await Promise.resolve();

    const replySet = actions.syncdb.set.mock.calls
      .map((x) => x[0])
      .find(
        (row: any) =>
          row?.event === "chat" &&
          row?.history?.[0]?.content === "reply content",
      );
    expect(replySet).toBeTruthy();
    expect(replySet.thread_id).toBe("thread-abc-1");
    expect(replySet.parent_message_id).toBe("root-msg-1");
    expect(replySet.reply_to_message_id).toBeUndefined();
    expect(replySet.reply_to).toBeUndefined();
    expect(typeof replySet.message_id).toBe("string");
    expect(replySet.message_id.length).toBeGreaterThan(0);
  });

  it("treats legacy reply_to-only sends as new threads", async () => {
    const rootDate = new Date("2026-02-21T17:59:00.000Z");
    const rootMs = rootDate.valueOf();
    const messages = new Map<string, any>([
      [
        `${rootMs}`,
        {
          event: "chat",
          sender_id: "00000000-1000-4000-8000-000000000001",
          date: rootDate,
          history: [
            {
              author_id: "00000000-1000-4000-8000-000000000001",
              content: "legacy root",
              date: rootDate.toISOString(),
            },
          ],
        },
      ],
    ]);
    const actions = makeActions(messages);

    const sent = actions.sendChat({
      input: "reply content",
      reply_thread_id: undefined,
    });
    await Promise.resolve();

    expect(sent).toBeTruthy();
    expect(actions.syncdb.set).toHaveBeenCalled();
    const newMessage = actions.syncdb.set.mock.calls[0]?.[0];
    expect(newMessage?.thread_id).toBeTruthy();
    expect(newMessage?.parent_message_id).toBeUndefined();
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
      if (
        where?.event === "chat-thread-config" &&
        where?.thread_id === threadId
      ) {
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
          archived: 1,
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
    expect(meta.archived).toBe(true);
    expect(meta.agent_kind).toBe("acp");
    expect(meta.agent_mode).toBe("interactive");
    expect(meta.agent_model).toBe("gpt-5.3-codex");
  });

  it("reads thread metadata from preview cache while syncdb is loading", () => {
    const threadId = "aaaaaaaa-1111-4111-8111-111111111111";
    const actions = makeActions();
    actions.syncdb.get_state = () => "loading";
    actions.messageCache.getThreadConfigPreviewById = (id: string) =>
      id === threadId
        ? ({
            event: "chat-thread-config",
            sender_id: "__thread_config__",
            date: "2026-02-21T18:00:00.000Z",
            thread_id: threadId,
            name: "Archived thread",
            archived: true,
          } as any)
        : undefined;
    const meta = actions.getThreadMetadata(threadId, { threadId });
    expect(meta.name).toBe("Archived thread");
    expect(meta.archived).toBe(true);
  });

  it("does not mutate thread config before syncdb is ready", () => {
    const actions = makeActions();
    actions.syncdb.get_state = () => "loading";
    actions.syncdb.delete.mockImplementation(() => {
      throw Error("must be ready -- delete");
    });

    expect(() => {
      actions.setThreadAgentMode("thread-1", "codex", {
        model: "gpt-5.3-codex-spark",
        workingDirectory: "/root",
      });
    }).not.toThrow();

    expect(actions.syncdb.delete).not.toHaveBeenCalled();
    expect(actions.syncdb.set).not.toHaveBeenCalled();
    expect(actions.syncdb.commit).not.toHaveBeenCalled();
  });

  it("updates thread-config by UUID thread key with a canonical thread row key", () => {
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
      if (
        where?.event === "chat-thread-config" &&
        where?.thread_id === threadId
      ) {
        return existing;
      }
      return undefined;
    });

    const ok = actions.setThreadAppearance(threadId, { name: "After" });
    expect(ok).toBe(true);
    expect(actions.syncdb.commit).toHaveBeenCalled();
    const setRow = actions.syncdb.set.mock.calls
      .map((x) => x[0])
      .find(
        (row: any) =>
          row?.event === "chat-thread-config" && row?.thread_id === threadId,
      );
    expect(setRow).toBeTruthy();
    expect(setRow.date).toBe(CHAT_THREAD_META_ROW_DATE);
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
      if (
        where?.event === "chat-thread-config" &&
        where?.thread_id === threadId
      ) {
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

  it("updates archived state for UUID thread keys", () => {
    const threadId = "34333333-3333-4333-8333-333333333333";
    const existing = {
      event: "chat-thread-config",
      sender_id: "__thread_config__",
      date: "2026-02-21T18:40:00.000Z",
      thread_id: threadId,
      name: "Thread",
    };
    const actions = makeActions();
    actions.syncdb.get_one.mockImplementation((where: any) => {
      if (
        where?.event === "chat-thread-config" &&
        where?.thread_id === threadId
      ) {
        return existing;
      }
      return undefined;
    });
    expect(actions.setThreadArchived(threadId, true)).toBe(true);
    const row = actions.syncdb.set.mock.calls
      .map((x) => x[0])
      .find(
        (x: any) =>
          x?.event === "chat-thread-config" &&
          x?.thread_id === threadId &&
          x?.archived === true,
      );
    expect(row).toBeTruthy();
  });

  it("updates thread-config for migrated legacy thread ids", () => {
    const threadId = "legacy-thread-1769012000306";
    const existing = {
      event: "chat-thread-config",
      sender_id: "__thread_config__",
      date: "2026-01-21T16:13:20.306Z",
      thread_id: threadId,
      archived: true,
      name: "Before",
    };
    const actions = makeActions();
    actions.syncdb.get_one.mockImplementation((where: any) => {
      if (
        where?.event === "chat-thread-config" &&
        where?.thread_id === threadId
      ) {
        return existing;
      }
      return undefined;
    });
    expect(actions.setThreadArchived(threadId, false)).toBe(true);
    expect(actions.setThreadAppearance(threadId, { name: "After" })).toBe(true);
    const rows = actions.syncdb.set.mock.calls.map((x) => x[0]);
    const archivedPatch = rows.find(
      (x: any) =>
        x?.event === "chat-thread-config" &&
        x?.thread_id === threadId &&
        x?.archived === false,
    );
    const namePatch = rows.find(
      (x: any) =>
        x?.event === "chat-thread-config" &&
        x?.thread_id === threadId &&
        x?.name === "After",
    );
    expect(archivedPatch).toBeTruthy();
    expect(namePatch).toBeTruthy();
  });

  it("updates non-codex agent model for UUID thread keys", () => {
    const threadId = "35333333-3333-4333-8333-333333333333";
    const existing = {
      event: "chat-thread-config",
      sender_id: "__thread_config__",
      date: "2026-02-21T18:40:00.000Z",
      thread_id: threadId,
      name: "Thread",
    };
    const actions = makeActions();
    actions.syncdb.get_one.mockImplementation((where: any) => {
      if (
        where?.event === "chat-thread-config" &&
        where?.thread_id === threadId
      ) {
        return existing;
      }
      return undefined;
    });
    actions.setThreadModel(threadId, "gpt-4o" as any);
    const row = actions.syncdb.set.mock.calls
      .map((x) => x[0])
      .find(
        (x: any) =>
          x?.event === "chat-thread-config" &&
          x?.thread_id === threadId &&
          x?.agent_model === "gpt-4o",
      );
    expect(row?.agent_kind).toBe("llm");
    expect(row?.agent_mode).toBe("single_turn");
  });

  it("creates a canonical thread-config row when updating by thread_id", () => {
    const threadId = "44444444-4444-4444-8444-444444444444";
    const actions = makeActions();

    const ok = actions.setThreadAppearance(threadId, { name: "Thread title" });
    expect(ok).toBe(true);
    const setRow = actions.syncdb.set.mock.calls
      .map((x) => x[0])
      .find(
        (row: any) =>
          row?.event === "chat-thread-config" && row?.thread_id === threadId,
      );
    expect(setRow).toBeTruthy();
    expect(setRow.date).toBe(CHAT_THREAD_META_ROW_DATE);
    expect(setRow.name).toBe("Thread title");
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
        (row: any) =>
          row?.event === "chat-thread-state" && row?.thread_id === threadA,
      ),
    ).toBeTruthy();
  });

  it("forkThread writes a canonical thread-config row and preserves codex metadata", async () => {
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
          thread_id: "thread-source-1",
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
    const actions = makeActions(messages);
    const sourceConfig = {
      event: "chat-thread-config",
      sender_id: "__thread_config__",
      date: rootIso,
      thread_id: "thread-source-1",
      name: "Original chat",
      thread_color: "#123456",
      thread_icon: "rocket",
      agent_kind: "acp",
      agent_mode: "interactive",
      agent_model: "gpt-5.3-codex",
      acp_config: {
        model: "gpt-5.3-codex",
        sessionId: "session-source-1",
        approvalPolicy: "full-auto",
      },
      loop_config: { enabled: true, max_turns: 12 },
    };
    actions.syncdb.get_one.mockImplementation((where: any) => {
      if (
        where?.event === "chat-thread-config" &&
        where?.thread_id === "thread-source-1"
      ) {
        return sourceConfig;
      }
      return undefined;
    });
    (webapp_client as any).conat_client = {
      ...(webapp_client as any).conat_client,
      forkAcpSession: jest
        .fn()
        .mockResolvedValue({ sessionId: "session-fork-1" }),
    };

    const newThreadId = await actions.forkThread({
      threadKey: "thread-source-1",
      title: "Forked chat",
      sourceTitle: "Original chat",
      isAI: true,
    });

    expect(newThreadId).toBeTruthy();
    const rows = actions.syncdb.set.mock.calls.map((x) => x[0]);
    const chatRow = rows.find(
      (row: any) => row?.event === "chat" && row?.thread_id === newThreadId,
    );
    expect(chatRow).toBeTruthy();
    const cfgRow = rows.find(
      (row: any) =>
        row?.event === "chat-thread-config" && row?.thread_id === newThreadId,
    );
    expect(cfgRow).toBeTruthy();
    expect(cfgRow.date).toBe(CHAT_THREAD_META_ROW_DATE);
    expect(cfgRow.name).toBe("Forked chat");
    expect(cfgRow.thread_color).toBe("#123456");
    expect(cfgRow.thread_icon).toBe("rocket");
    expect(cfgRow.agent_kind).toBe("acp");
    expect(cfgRow.agent_mode).toBe("interactive");
    expect(cfgRow.agent_model).toBe("gpt-5.3-codex");
    expect(cfgRow.acp_config).toEqual(
      expect.objectContaining({
        model: "gpt-5.3-codex",
        sessionId: "session-fork-1",
        approvalPolicy: "full-auto",
      }),
    );
    expect(cfgRow.loop_config).toEqual({ enabled: true, max_turns: 12 });
    expect(cfgRow.loop_state).toBeNull();
    expect(actions.setSelectedThread).toHaveBeenCalledWith(newThreadId);
    expect(
      (webapp_client as any).conat_client.forkAcpSession,
    ).toHaveBeenCalledWith({
      project_id: "proj-1",
      sessionId: "session-source-1",
    });
  });

  it("forkThread reuses the latest acp_thread_id when thread-config sessionId is not yet persisted", async () => {
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
          message_id: "root-msg-2",
          thread_id: "thread-source-2",
          history: [
            {
              author_id: "00000000-1000-4000-8000-000000000001",
              content: "root",
              date: rootIso,
            },
          ],
        },
      ],
      [
        `${rootMs + 1}`,
        {
          event: "chat",
          sender_id: "openai-codex-agent",
          date: new Date(rootMs + 1),
          message_id: "assistant-msg-2",
          thread_id: "thread-source-2",
          acp_thread_id: "codex-session-live-2",
          history: [
            {
              author_id: "openai-codex-agent",
              content: "working",
              date: new Date(rootMs + 1).toISOString(),
            },
          ],
        },
      ],
    ]);
    const actions = makeActions(messages);
    const sourceConfig = {
      event: "chat-thread-config",
      sender_id: "__thread_config__",
      date: rootIso,
      thread_id: "thread-source-2",
      name: "Original chat",
      agent_kind: "acp",
      agent_mode: "interactive",
      agent_model: "gpt-5.3-codex",
      acp_config: {
        model: "gpt-5.3-codex",
        approvalPolicy: "full-auto",
      },
    };
    actions.syncdb.get_one.mockImplementation((where: any) => {
      if (
        where?.event === "chat-thread-config" &&
        where?.thread_id === "thread-source-2"
      ) {
        return sourceConfig;
      }
      return undefined;
    });
    (webapp_client as any).conat_client = {
      ...(webapp_client as any).conat_client,
      forkAcpSession: jest
        .fn()
        .mockResolvedValue({ sessionId: "session-fork-2" }),
    };

    const newThreadId = await actions.forkThread({
      threadKey: "thread-source-2",
      title: "Forked chat",
      sourceTitle: "Original chat",
      isAI: true,
    });

    expect(newThreadId).toBeTruthy();
    const rows = actions.syncdb.set.mock.calls.map((x) => x[0]);
    const cfgRow = rows.find(
      (row: any) =>
        row?.event === "chat-thread-config" && row?.thread_id === newThreadId,
    );
    expect(cfgRow).toBeTruthy();
    expect(cfgRow.acp_config).toEqual(
      expect.objectContaining({
        model: "gpt-5.3-codex",
        sessionId: "session-fork-2",
        approvalPolicy: "full-auto",
      }),
    );
    expect(
      (webapp_client as any).conat_client.forkAcpSession,
    ).toHaveBeenCalledWith({
      project_id: "proj-1",
      sessionId: "codex-session-live-2",
    });
  });

  it("can fork without auto-selecting the new thread", async () => {
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
          message_id: "root-msg-3",
          thread_id: "thread-source-3",
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
    const actions = makeActions(messages);

    const newThreadId = await actions.forkThread({
      threadKey: "thread-source-3",
      title: "Fork without selecting",
      sourceTitle: "Original chat",
      isAI: false,
      selectNewThread: false,
    });

    expect(newThreadId).toBeTruthy();
    expect(actions.setSelectedThread).not.toHaveBeenCalled();
    const cfgRow = actions.syncdb.set.mock.calls
      .map((x) => x[0])
      .find(
        (row: any) =>
          row?.event === "chat-thread-config" && row?.thread_id === newThreadId,
      );
    expect(cfgRow?.name).toBe("Fork without selecting");
  });

  it("does not delete by timestamp keys anymore", () => {
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
    expect(deleted).toBe(0);
    const chatDeletes = actions.syncdb.delete.mock.calls
      .map((x) => x[0])
      .filter((row: any) => row?.event === "chat");
    expect(chatDeletes).toHaveLength(0);
  });

  it("deletes config-only migrated legacy threads", () => {
    const thread = "legacy-thread-1769012000306";
    const actions = makeActions(new Map());
    actions.syncdb.get_one.mockImplementation((where: any) => {
      if (
        where?.event === "chat-thread-config" &&
        where?.thread_id === thread
      ) {
        return {
          event: "chat-thread-config",
          sender_id: "__thread_config__",
          date: "2026-01-21T16:13:20.306Z",
          thread_id: thread,
        };
      }
      return undefined;
    });
    const deleted = actions.deleteThread(thread);
    expect(deleted).toBe(1);
    expect(actions.syncdb.commit).toHaveBeenCalled();
    const deletes = actions.syncdb.delete.mock.calls.map((x) => x[0]);
    expect(
      deletes.find(
        (row: any) =>
          row?.event === "chat-thread-config" && row?.thread_id === thread,
      ),
    ).toBeTruthy();
    expect(
      deletes.find(
        (row: any) =>
          row?.event === "chat-thread-state" && row?.thread_id === thread,
      ),
    ).toBeTruthy();
  });
});

describe("deleteMessage rewiring", () => {
  it("rewires direct children to the deleted message parent", () => {
    const threadId = "12121212-1212-4212-8212-121212121212";
    const d1 = new Date("2026-02-21T22:00:00.000Z");
    const d2 = new Date("2026-02-21T22:01:00.000Z");
    const d3 = new Date("2026-02-21T22:02:00.000Z");
    const d4 = new Date("2026-02-21T22:03:00.000Z");
    const messages = new Map<string, any>([
      [
        `${d1.valueOf()}`,
        {
          event: "chat",
          sender_id: "u1",
          date: d1,
          thread_id: threadId,
          message_id: "root",
          history: [],
        },
      ],
      [
        `${d2.valueOf()}`,
        {
          event: "chat",
          sender_id: "u1",
          date: d2,
          thread_id: threadId,
          message_id: "middle",
          parent_message_id: "root",
          reply_to: d1.toISOString(),
          reply_to_message_id: "root",
          history: [],
        },
      ],
      [
        `${d3.valueOf()}`,
        {
          event: "chat",
          sender_id: "u2",
          date: d3,
          thread_id: threadId,
          message_id: "leaf",
          parent_message_id: "middle",
          reply_to: d2.toISOString(),
          reply_to_message_id: "middle",
          history: [],
        },
      ],
      [
        `${d4.valueOf()}`,
        {
          event: "chat",
          sender_id: "u3",
          date: d4,
          thread_id: "34343434-3434-4343-8343-343434343434",
          message_id: "other",
          history: [],
        },
      ],
    ]);
    const actions = makeActions(messages);

    const deleted = actions.deleteMessage(messages.get(`${d2.valueOf()}`));

    expect(deleted).toBe(true);
    expect(actions.syncdb.commit).toHaveBeenCalled();
    expect(actions.syncdb.delete).toHaveBeenCalledWith({
      event: "chat",
      date: d2.toISOString(),
      sender_id: "u1",
    });
    const rewired = actions.syncdb.set.mock.calls
      .map((x) => x[0])
      .find((row: any) => row?.event === "chat" && row?.message_id === "leaf");
    expect(rewired).toBeTruthy();
    expect(rewired.parent_message_id).toBe("root");
    expect(rewired.reply_to_message_id).toBe("root");
    expect(rewired.reply_to).toBe(d1.toISOString());
  });

  it("clears child reply links when deleting the root message", () => {
    const threadId = "56565656-5656-4565-8565-565656565656";
    const d1 = new Date("2026-02-21T23:00:00.000Z");
    const d2 = new Date("2026-02-21T23:01:00.000Z");
    const messages = new Map<string, any>([
      [
        `${d1.valueOf()}`,
        {
          event: "chat",
          sender_id: "u1",
          date: d1,
          thread_id: threadId,
          message_id: "root",
          history: [],
        },
      ],
      [
        `${d2.valueOf()}`,
        {
          event: "chat",
          sender_id: "u2",
          date: d2,
          thread_id: threadId,
          message_id: "child",
          parent_message_id: "root",
          reply_to: d1.toISOString(),
          reply_to_message_id: "root",
          history: [],
        },
      ],
    ]);
    const actions = makeActions(messages);

    const deleted = actions.deleteMessage(messages.get(`${d1.valueOf()}`));

    expect(deleted).toBe(true);
    const rewired = actions.syncdb.set.mock.calls
      .map((x) => x[0])
      .find((row: any) => row?.event === "chat" && row?.message_id === "child");
    expect(rewired).toBeTruthy();
    expect(rewired.parent_message_id).toBeNull();
    expect(rewired.reply_to_message_id).toBeNull();
    expect(rewired.reply_to).toBeNull();
    expect(
      actions.syncdb.delete.mock.calls
        .map((x) => x[0])
        .filter((row: any) => row?.event === "chat-thread-config"),
    ).toHaveLength(0);
  });

  it("removes thread metadata when deleting the only remaining message", () => {
    const threadId = "78787878-7878-4787-8787-787878787878";
    const d1 = new Date("2026-02-22T00:00:00.000Z");
    const messages = new Map<string, any>([
      [
        `${d1.valueOf()}`,
        {
          event: "chat",
          sender_id: "u1",
          date: d1,
          thread_id: threadId,
          message_id: "solo",
          history: [],
        },
      ],
    ]);
    const actions = makeActions(messages);

    const deleted = actions.deleteMessage(messages.get(`${d1.valueOf()}`));

    expect(deleted).toBe(true);
    const deletes = actions.syncdb.delete.mock.calls.map((x) => x[0]);
    expect(
      deletes.find(
        (row: any) =>
          row?.event === "chat-thread-config" && row?.thread_id === threadId,
      ),
    ).toBeTruthy();
    expect(
      deletes.find(
        (row: any) =>
          row?.event === "chat-thread-state" && row?.thread_id === threadId,
      ),
    ).toBeTruthy();
  });
});

describe("markThreadRead with UUID keys", () => {
  it("updates read marker on the UUID-thread root row", () => {
    const threadId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const d1 = new Date("2026-02-21T21:00:00.000Z");
    const d2 = new Date("2026-02-21T21:01:00.000Z");
    const messages = new Map<string, any>([
      [
        `${d1.valueOf()}`,
        {
          event: "chat",
          sender_id: "u1",
          date: d1,
          thread_id: threadId,
          message_id: "root",
          history: [],
        },
      ],
      [
        `${d2.valueOf()}`,
        {
          event: "chat",
          sender_id: "u1",
          date: d2,
          thread_id: threadId,
          message_id: "reply",
          reply_to: d1.toISOString(),
          history: [],
        },
      ],
    ]);
    const actions = makeActions(messages);
    actions.syncdb.get_one.mockImplementation((where: any) => {
      if (
        where?.event === "chat-thread-config" &&
        where?.thread_id === threadId
      ) {
        return {
          event: "chat-thread-config",
          sender_id: "__thread_config__",
          date: d1.toISOString(),
          thread_id: threadId,
        };
      }
      return undefined;
    });
    const ok = actions.markThreadRead(threadId, 7);
    expect(ok).toBe(true);
    expect(actions.syncdb.commit).toHaveBeenCalled();
    const row = actions.syncdb.set.mock.calls
      .map((x) => x[0])
      .find(
        (x: any) =>
          x?.event === "chat-thread-config" && x?.thread_id === threadId,
      );
    expect(row?.["read-00000000-1000-4000-8000-000000000001"]).toBe(7);
  });
});
