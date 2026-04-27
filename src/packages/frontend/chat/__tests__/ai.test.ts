/** @jest-environment jsdom */

import track from "@cocalc/frontend/user-tracking";
import { processAI } from "../actions/ai";
import { processAcpLLM } from "../acp-api";

jest.mock("@cocalc/frontend/user-tracking", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("../acp-api", () => ({
  processAcpLLM: jest.fn(),
}));

function makeActions(): any {
  return {
    syncdb: {
      set: jest.fn(),
      commit: jest.fn(),
      get_one: jest.fn(),
      delete: jest.fn(),
      save: jest.fn(),
    },
    store: {
      get: (key: string) =>
        key === "project_id"
          ? "proj"
          : key === "path"
            ? "chat.chat"
            : undefined,
    },
    recordThreadAgentModel: jest.fn(),
    getLLMHistory: jest.fn(() => []),
  };
}

function makeMessage(overrides: Record<string, any> = {}) {
  return {
    event: "chat" as const,
    sender_id: "user-1",
    thread_id: "thread-test-1",
    history: [
      {
        author_id: "00000000-1000-4000-8000-000000000001",
        content: "hello",
        date: "2025-02-02T00:00:00.000Z",
      },
    ],
    date: new Date("2025-02-02T00:00:00.000Z"),
    ...overrides,
  };
}

describe("processAI Codex dispatch", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("routes Codex thread models through ACP and records the model", async () => {
    const actions = makeActions();
    const message = makeMessage({
      history: [
        {
          author_id: "00000000-1000-4000-8000-000000000001",
          content: "please continue",
          date: "2025-02-02T00:00:00.000Z",
        },
      ],
    });

    await processAI({
      actions,
      message,
      threadModel: "gpt-5.4",
    });

    expect(actions.recordThreadAgentModel).toHaveBeenCalledWith(
      "thread-test-1",
      "gpt-5.4",
    );
    expect(processAcpLLM).toHaveBeenCalledWith(
      expect.objectContaining({
        actions,
        message,
        model: "gpt-5.4",
        input: "please continue",
        sendMode: undefined,
      }),
    );
    expect(track).toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({
        project_id: "proj",
        path: "chat.chat",
        model: "gpt-5.4",
      }),
    );
  });

  it("uses the Codex mention when there is no thread model", async () => {
    const actions = makeActions();
    const message = makeMessage({
      history: [
        {
          author_id: "00000000-1000-4000-8000-000000000001",
          content: "@codex fix this",
          date: "2025-02-02T00:00:00.000Z",
        },
      ],
    });

    await processAI({
      actions,
      message,
      threadModel: false,
    });

    expect(processAcpLLM).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "codex-agent",
        input: "fix this",
      }),
    );
    expect(actions.recordThreadAgentModel).toHaveBeenCalledWith(
      "thread-test-1",
      "codex-agent",
    );
  });

  it("prefers acp_prompt and preserves immediate send mode", async () => {
    const actions = makeActions();
    const message = makeMessage({
      acp_prompt: "Use the project context instead",
      acp_send_mode: "immediate",
      history: [
        {
          author_id: "00000000-1000-4000-8000-000000000001",
          content: "@codex thanks",
          date: "2025-02-02T00:00:00.000Z",
        },
      ],
    });

    await processAI({
      actions,
      message,
      threadModel: "codex-agent",
    });

    expect(processAcpLLM).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "codex-agent",
        input: "Use the project context instead",
        sendMode: "immediate",
      }),
    );
  });

  it("ignores non-Codex thread and regenerate models", async () => {
    const actions = makeActions();
    const message = makeMessage();

    await processAI({
      actions,
      message,
      threadModel: "gpt-4" as any,
    });
    await processAI({
      actions,
      message,
      tag: "regenerate",
      llm: "gpt-4" as any,
      threadModel: "codex-agent",
    });

    expect(processAcpLLM).not.toHaveBeenCalled();
    expect(actions.recordThreadAgentModel).not.toHaveBeenCalled();
  });
});
