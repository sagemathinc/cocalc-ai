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

test.each(["answer", "cancel"])(
  "ACP durable attention %s lifecycle",
  async (action) => {
    const handler = createCodexAttentionHandler({} as any, "ACP");
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
        expect(record.summary).toBe("The current ACP turn is paused.");
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
    }
  },
);
