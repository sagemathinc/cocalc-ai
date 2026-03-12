/** @jest-environment jsdom */

import {
  cancelQueuedAcpTurn,
  processAcpLLM,
  resetAcpApiStateForTests,
  sendQueuedAcpTurnImmediately,
} from "../acp-api";

const mockStreamAcp = jest.fn();
const mockControlAcp = jest.fn();
const mockInterruptAcp = jest.fn();

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      streamAcp: (...args: any[]) => mockStreamAcp(...args),
      controlAcp: (...args: any[]) => mockControlAcp(...args),
      interruptAcp: (...args: any[]) => mockInterruptAcp(...args),
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
    resetAcpApiStateForTests();
  });

  it("retries a no-ack ACP submission with interrupt and backoff", async () => {
    jest.spyOn(Date, "now").mockReturnValue(4500);
    jest.spyOn(global, "setTimeout").mockImplementation(((fn: any) => {
      fn();
      return 0 as any;
    }) as any);
    mockStreamAcp
      .mockResolvedValueOnce(
        (async function* () {
          return;
        })(),
      )
      .mockResolvedValueOnce(queuedAckStream("queued"));
    mockInterruptAcp.mockResolvedValue(undefined);

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
            "4500",
            {
              date: new Date(4500),
              message_id: "root-msg-45",
              thread_id: "thread-45",
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
      date: new Date(4500),
      message_id: "user-msg-45",
      thread_id: "thread-45",
      history: [
        {
          author_id: "user-1",
          content: "retry please",
          date: new Date(4500).toISOString(),
        },
      ],
    };

    await processAcpLLM({
      message,
      model: "codex-agent",
      input: "retry please",
      actions,
    });

    expect(mockStreamAcp).toHaveBeenCalledTimes(2);
    expect(mockStreamAcp.mock.calls[0][1]).toEqual({ timeout: 120000 });
    expect(mockInterruptAcp).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "proj",
        threadId: "thread-45",
      }),
    );
    expect(acpState.get("message:user-msg-45")).toBe("queue");
  });

  it("chooses a unique assistant message timestamp", async () => {
    jest.spyOn(Date, "now").mockReturnValue(1000);
    jest.spyOn(global, "setTimeout").mockImplementation(((fn: any) => {
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
    jest.spyOn(global, "setTimeout").mockImplementation(((fn: any) => {
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
    jest.spyOn(global, "setTimeout").mockImplementation(((fn: any) => {
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

  it("does not reuse stale thread loop config for a later normal turn", async () => {
    jest.spyOn(Date, "now").mockReturnValue(3500);
    jest.spyOn(global, "setTimeout").mockImplementation(((fn: any) => {
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

    const messageDate = new Date(3500);
    const actions: any = {
      syncdb: {},
      store,
      chatStreams: new Set<string>(),
      getAllMessages: () =>
        new Map<string, any>([
          [
            "3500",
            {
              date: messageDate,
              message_id: "root-msg-loop",
              thread_id: "thread-loop",
            },
          ],
        ]),
      getCodexConfig: jest.fn(() => undefined),
      getThreadMetadata: jest.fn(() => ({
        loop_config: { enabled: true, max_turns: 5 },
      })),
      getMessagesInThread: jest.fn(() => []),
      sendReply: jest.fn(),
    };

    const message: any = {
      event: "chat",
      sender_id: "user-1",
      date: messageDate,
      message_id: "user-msg-loop",
      thread_id: "thread-loop",
      history: [
        {
          author_id: "user-1",
          content: "normal turn please",
          date: messageDate.toISOString(),
        },
      ],
    };

    await processAcpLLM({
      message,
      model: "codex-agent",
      input: "normal turn please",
      actions,
    });

    const arg = mockStreamAcp.mock.calls[0][0];
    expect(arg.chat.loop_config).toBeUndefined();
    expect(arg.prompt).toBe("normal turn please");
    expect(arg.prompt).not.toContain("System loop contract");
  });

  it("suppresses loop-contract json on a later normal turn after loop history", async () => {
    jest.spyOn(Date, "now").mockReturnValue(3600);
    jest.spyOn(global, "setTimeout").mockImplementation(((fn: any) => {
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

    const messageDate = new Date(3600);
    const actions: any = {
      syncdb: {},
      store,
      chatStreams: new Set<string>(),
      getAllMessages: () =>
        new Map<string, any>([
          [
            "3600",
            {
              date: messageDate,
              message_id: "root-msg-loop-history",
              thread_id: "thread-loop-history",
            },
          ],
        ]),
      getCodexConfig: jest.fn(() => undefined),
      getThreadMetadata: jest.fn(() => ({
        loop_state: {
          loop_id: "loop-1",
          status: "stopped",
          iteration: 2,
          started_at_ms: 1000,
          updated_at_ms: 2000,
          stop_reason: "completed",
        },
      })),
      getMessagesInThread: jest.fn(() => []),
      sendReply: jest.fn(),
    };

    const message: any = {
      event: "chat",
      sender_id: "user-1",
      date: messageDate,
      message_id: "user-msg-loop-history",
      thread_id: "thread-loop-history",
      history: [
        {
          author_id: "user-1",
          content: "normal turn after loop",
          date: messageDate.toISOString(),
        },
      ],
    };

    await processAcpLLM({
      message,
      model: "codex-agent",
      input: "normal turn after loop",
      actions,
    });

    const arg = mockStreamAcp.mock.calls.at(-1)[0];
    expect(arg.chat.loop_config).toBeUndefined();
    expect(arg.prompt).not.toContain("System loop contract (required):");
    expect(arg.prompt).toContain("System loop mode: OFF for this turn.");
    expect(arg.prompt).toContain(
      'Do not include the special loop-control JSON block with schema {"loop":...}',
    );
  });

  it("keeps queued state on the submitted message after backend acknowledgement", async () => {
    jest.spyOn(Date, "now").mockReturnValue(4000);
    jest.spyOn(global, "setTimeout").mockImplementation(((fn: any) => {
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

describe("queued ACP controls", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("updates local state after sending a queued turn immediately", async () => {
    mockControlAcp.mockResolvedValue({ ok: true });
    const acpState = new FakeAcpState();
    acpState.set("message:user-msg-queued", "queue");
    const store: any = {
      get: (key: string) => {
        if (key === "project_id") return "proj";
        if (key === "path") return "x.chat";
        if (key === "acpState") return acpState;
        return undefined;
      },
      setState: jest.fn(),
    };
    const actions: any = { store };
    const message: any = {
      message_id: "user-msg-queued",
      thread_id: "thread-queued",
    };

    await expect(
      sendQueuedAcpTurnImmediately({ actions, message }),
    ).resolves.toBe(true);

    expect(mockControlAcp).toHaveBeenCalledWith({
      project_id: "proj",
      path: "x.chat",
      thread_id: "thread-queued",
      user_message_id: "user-msg-queued",
      action: "send_immediately",
    });
    expect(store.setState).toHaveBeenCalledWith({
      acpState,
    });
    expect(acpState.get("message:user-msg-queued")).toBe("sent");
  });

  it("updates local state after cancelling a queued turn", async () => {
    mockControlAcp.mockResolvedValue({ ok: true });
    const acpState = new FakeAcpState();
    acpState.set("message:user-msg-queued", "queue");
    const store: any = {
      get: (key: string) => {
        if (key === "project_id") return "proj";
        if (key === "path") return "x.chat";
        if (key === "acpState") return acpState;
        return undefined;
      },
      setState: jest.fn(),
    };
    const actions: any = { store };
    const message: any = {
      message_id: "user-msg-queued",
      thread_id: "thread-queued",
    };

    await expect(cancelQueuedAcpTurn({ actions, message })).resolves.toBe(true);

    expect(acpState.get("message:user-msg-queued")).toBe("not-sent");
  });
});
