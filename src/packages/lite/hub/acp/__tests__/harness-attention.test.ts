import { createCodexAttentionHandler } from "../codex-attention";
import { initAcpDatabase, closeAcpDatabase } from "../../sqlite/acp-database";
import {
  getAcpAttention,
  submitAcpAttentionResponse,
} from "../../sqlite/acp-attention";
import type { CodexAttentionContext } from "@cocalc/ai/acp";

jest.mock("@cocalc/conat/hub/call-hub", () => ({
  __esModule: true,
  default: jest.fn(async () => undefined),
}));

beforeEach(() => initAcpDatabase({ filename: ":memory:" }));
afterEach(() => closeAcpDatabase());

test("Claude async questions are durable, idempotent and survive turn completion", async () => {
  const handler = createCodexAttentionHandler({} as any, {
    runtimeLabel: "Claude",
  });
  const context: CodexAttentionContext = {
    projectId: "project",
    accountId: "account",
    threadId: "native",
    turnId: "turn",
    chat: {
      project_id: "project",
      path: "claude.chat",
      thread_id: "conversation",
      harness_session_id: "native",
      sender_id: "acp-harness",
      message_date: new Date().toISOString(),
    },
    stream: async () => {},
  };
  const input = {
    itemId: "target",
    questions: [{ id: "target", header: "Target", question: "Which target?" }],
    context,
  };
  const first = await handler.createAsyncQuestion(input);
  expect(first.is_blocking).toBe(false);
  expect(first.summary).toContain("Claude may continue");
  expect((await handler.createAsyncQuestion(input)).attention_id).toBe(
    first.attention_id,
  );
  await expect(
    handler.createAsyncQuestion({
      ...input,
      questions: [{ ...input.questions[0], question: "Changed?" }],
    }),
  ).rejects.toThrow(/different questions/);
  await handler.runtimeClosed?.(context);
  expect(getAcpAttention(first.attention_id)?.state).toBe("pending");
  expect(getAcpAttention(first.attention_id)?.chat.harness_session_id).toBe(
    "native",
  );
});

test.each(["answer", "cancel"])(
  "ACP durable attention %s lifecycle",
  async (action) => {
    const onSyncResponseResolved = jest.fn(async () => {});
    const handler = createCodexAttentionHandler({} as any, {
      runtimeLabel: "ACP",
      onSyncResponseResolved,
    });
    const abort = new AbortController();
    let id = "";
    const context: CodexAttentionContext = {
      projectId: "11111111-1111-4111-8111-111111111111",
      accountId: "22222222-2222-4222-8222-222222222222",
      threadId: "native-session",
      turnId: "acp-execution",
      chat: {
        project_id: "11111111-1111-4111-8111-111111111111",
        path: "a.chat",
        thread_id: "conversation",
        sender_id: "agent",
        message_date: new Date().toISOString(),
      },
      stream: async (payload) => {
        if (payload?.type !== "event" || payload.event.type !== "attention")
          return;
        const record = payload.event.request;
        id = record.attention_id;
        expect(record.summary).toBe("The current agent turn is paused.");
        expect(record.turn_id).toBe(context.turnId);
        if (action === "cancel") {
          abort.abort();
          return;
        }
        submitAcpAttentionResponse({
          attention_id: id,
          account_id: context.accountId,
          project_id: context.projectId,
          response_id: "reply",
          answers: { target: ["local"] },
        });
      },
    };
    const pending = handler.requestSyncQuestion({
      requestId: "question",
      itemId: "question",
      isBlocking: true,
      questions: [
        {
          id: "target",
          header: "Target",
          question: "Choose target",
          options: [
            { label: "local", description: "local" },
            { label: "staging", description: "staging" },
          ],
        },
      ],
      context,
      signal: abort.signal,
    });
    if (action === "cancel") {
      await expect(pending).rejects.toThrow();
      expect(getAcpAttention(id)?.state).toBe("stale");
    } else {
      await expect(pending).resolves.toEqual({
        target: { answers: ["local"] },
      });
      await handler.serverRequestResolved?.({ requestId: "question", context });
      await handler.runtimeClosed?.(context);
      expect(getAcpAttention(id)?.state).toBe("answered");
      expect(getAcpAttention(id)?.resolution_reason).toBe(
        "ACP accepted the response",
      );
      expect(onSyncResponseResolved).toHaveBeenCalledWith(
        expect.objectContaining({ attention_id: id, state: "answered" }),
      );
    }
  },
);
