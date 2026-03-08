/** @jest-environment jsdom */

import { processAcpLLM } from "../acp-api";

const mockStreamAcp = jest.fn();

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      streamAcp: (...args: any[]) => mockStreamAcp(...args),
      getProjectHostAcpBearer: async () => "",
    },
  },
}));

function queuedAckStream(state: "queued" | "running" = "queued") {
  return (async function* () {
    yield { seq: 0, type: "status", state };
  })();
}

class FakeAcpState {
  private readonly map = new Map<string, string>();

  set(key: string, value: string) {
    this.map.set(key, value);
    return this;
  }

  delete(key: string) {
    this.map.delete(key);
    return this;
  }

  get(key: string) {
    return this.map.get(key);
  }
}

describe("processAcpLLM", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it("chooses a unique assistant message timestamp", async () => {
    jest.spyOn(Date, "now").mockReturnValue(1000);
    jest
      .spyOn(global, "setTimeout")
      .mockImplementation(((fn: any) => {
        fn();
        return 0 as any;
      }) as any);
    mockStreamAcp.mockResolvedValue(queuedAckStream());

    const acpState = new FakeAcpState();
    const store: any = {
      get: (key: string) => {
        if (key === "project_id") return "proj";
        if (key === "path") return "x.chat";
        if (key === "acpState") return acpState;
        return undefined;
      },
      setState: jest.fn(),
    };

    const actions: any = {
      syncdb: {},
      store,
      chatStreams: new Set<string>(),
      computeThreadKey: jest.fn(() => "1000"),
      getAllMessages: () =>
        new Map<string, any>([
          [
            "1000",
            {
              date: new Date(1000),
              message_id: "root-msg-1",
              thread_id: "thread-1",
            },
          ],
          ["1001", { date: new Date(1001) }],
          ["1002", { date: new Date(1002) }],
        ]),
      getCodexConfig: jest.fn(),
      sendReply: jest.fn(),
    };

    const message: any = {
      event: "chat",
      sender_id: "user-1",
      date: new Date(1000),
      message_id: "user-msg-1",
      thread_id: "thread-1",
      history: [
        {
          author_id: "user-1",
          content: "run codex",
          date: new Date(1000).toISOString(),
        },
      ],
    };

    await processAcpLLM({
      message,
      model: "codex-agent",
      input: "run codex",
      actions,
    });

    expect(mockStreamAcp).toHaveBeenCalledTimes(1);
    const arg = mockStreamAcp.mock.calls[0][0];
    expect(arg.chat.message_date).toBe(new Date(1003).toISOString());
    expect(arg.chat.reply_to).toBeUndefined();
    expect(typeof arg.chat.message_id).toBe("string");
    expect(arg.chat.message_id).toBeTruthy();
    expect(arg.chat.message_id).not.toBe("user-msg-1");
    expect(arg.chat.thread_id).toBe("thread-1");
    expect(arg.chat.parent_message_id).toBe("user-msg-1");
    expect(arg.chat.reply_to_message_id).toBeUndefined();
    expect(arg.session_id).toBe("thread-1");
  });

  it("reuses latest acp_thread_id when thread-config sessionId is not yet persisted", async () => {
    jest.spyOn(Date, "now").mockReturnValue(2000);
    jest
      .spyOn(global, "setTimeout")
      .mockImplementation(((fn: any) => {
        fn();
        return 0 as any;
      }) as any);
    mockStreamAcp.mockResolvedValue(queuedAckStream());

    const acpState = new FakeAcpState();
    const store: any = {
      get: (key: string) => {
        if (key === "project_id") return "proj";
        if (key === "path") return "x.chat";
        if (key === "acpState") return acpState;
        return undefined;
      },
      setState: jest.fn(),
    };

    const threadRoot = new Date(2000);
    const actions: any = {
      syncdb: {},
      store,
      chatStreams: new Set<string>(),
      computeThreadKey: jest.fn(() => "2000"),
      getAllMessages: () =>
        new Map<string, any>([
          [
            "2000",
            {
              date: threadRoot,
              message_id: "root-msg-2",
              thread_id: "thread-2",
            },
          ],
        ]),
      getMessagesInThread: jest.fn(() => [
        {
          date: new Date(2001),
          message_id: "assistant-msg-1",
          acp_thread_id: "codex-session-123",
        },
      ]),
      getCodexConfig: jest.fn(() => ({ model: "gpt-5.3-codex" })),
      sendReply: jest.fn(),
    };

    const message: any = {
      event: "chat",
      sender_id: "user-1",
      date: threadRoot,
      message_id: "user-msg-2",
      thread_id: "thread-2",
      history: [
        {
          author_id: "user-1",
          content: "continue",
          date: threadRoot.toISOString(),
        },
      ],
      reply_to: threadRoot.toISOString(),
    };

    await processAcpLLM({
      message,
      model: "codex-agent",
      input: "continue",
      actions,
    });

    expect(mockStreamAcp).toHaveBeenCalledTimes(1);
    const arg = mockStreamAcp.mock.calls[0][0];
    expect(arg.session_id).toBe("codex-session-123");
    expect(arg.config?.sessionId).toBe("codex-session-123");
    expect(arg.chat.reply_to).toBeUndefined();
  });

  it("prefers explicit ACP config override over lookup defaults", async () => {
    jest.spyOn(Date, "now").mockReturnValue(3000);
    jest
      .spyOn(global, "setTimeout")
      .mockImplementation(((fn: any) => {
        fn();
        return 0 as any;
      }) as any);
    mockStreamAcp.mockResolvedValue(queuedAckStream());

    const acpState = new FakeAcpState();
    const store: any = {
      get: (key: string) => {
        if (key === "project_id") return "proj";
        if (key === "path") return "x.chat";
        if (key === "acpState") return acpState;
        return undefined;
      },
      setState: jest.fn(),
    };

    const messageDate = new Date(3000);
    const actions: any = {
      syncdb: {},
      store,
      chatStreams: new Set<string>(),
      computeThreadKey: jest.fn(() => "3000"),
      getAllMessages: () =>
        new Map<string, any>([
          [
            "3000",
            {
              date: messageDate,
              message_id: "root-msg-3",
              thread_id: "thread-3",
            },
          ],
        ]),
      getCodexConfig: jest.fn(() => undefined),
      getThreadMetadata: jest.fn(() => undefined),
      getMessagesInThread: jest.fn(() => []),
      sendReply: jest.fn(),
    };

    const message: any = {
      event: "chat",
      sender_id: "user-1",
      date: messageDate,
      message_id: "user-msg-3",
      thread_id: "thread-3",
      history: [
        {
          author_id: "user-1",
          content: "run codex",
          date: messageDate.toISOString(),
        },
      ],
    };

    await processAcpLLM({
      message,
      model: "gpt-5.3-codex-spark",
      input: "run codex",
      actions,
      acpConfigOverride: {
        model: "gpt-5.3-codex-spark",
        sessionMode: "full-access",
        reasoning: "extra_high",
      },
    });

    const arg = mockStreamAcp.mock.calls[0][0];
    expect(arg.config).toEqual(
      expect.objectContaining({
        model: "gpt-5.3-codex-spark",
        sessionMode: "full-access",
        reasoning: "extra_high",
        allowWrite: true,
      }),
    );
  });

  it("keeps queued state on the submitted message after backend acknowledgement", async () => {
    jest.spyOn(Date, "now").mockReturnValue(4000);
    jest
      .spyOn(global, "setTimeout")
      .mockImplementation(((fn: any) => {
        fn();
        return 0 as any;
      }) as any);
    mockStreamAcp.mockResolvedValue(queuedAckStream("queued"));

    const acpState = new FakeAcpState();
    const store: any = {
      get: (key: string) => {
        if (key === "project_id") return "proj";
        if (key === "path") return "x.chat";
        if (key === "acpState") return acpState;
        return undefined;
      },
      setState: jest.fn(),
    };

    const actions: any = {
      syncdb: { commit: jest.fn() },
      store,
      chatStreams: new Set<string>(),
      getAllMessages: () =>
        new Map<string, any>([
          [
            "4000",
            {
              date: new Date(4000),
              message_id: "root-msg-4",
              thread_id: "thread-4",
            },
          ],
        ]),
      getThreadMetadata: jest.fn(() => undefined),
      getMessagesInThread: jest.fn(() => []),
      getCodexConfig: jest.fn(() => undefined),
      sendReply: jest.fn(),
    };

    const message: any = {
      event: "chat",
      sender_id: "user-1",
      date: new Date(4000),
      message_id: "user-msg-4",
      thread_id: "thread-4",
      history: [
        {
          author_id: "user-1",
          content: "queued turn",
          date: new Date(4000).toISOString(),
        },
      ],
    };

    await processAcpLLM({
      message,
      model: "codex-agent",
      input: "queued turn",
      actions,
    });

    expect(acpState.get("message:user-msg-4")).toBe("queue");
  });
});
