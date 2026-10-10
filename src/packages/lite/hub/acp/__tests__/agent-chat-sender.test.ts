import {
  DEFAULT_AGENT_CHAT_SENDER_ID,
  resolveAgentChatSenderId,
} from "../agent-chat-sender";

describe("agent chat sender", () => {
  it("uses the thread agent model when available", () => {
    expect(resolveAgentChatSenderId("gpt-5.4")).toBe("gpt-5.4");
  });

  it("falls back to the default codex sender when the model is missing", () => {
    expect(resolveAgentChatSenderId(undefined)).toBe(
      DEFAULT_AGENT_CHAT_SENDER_ID,
    );
    expect(resolveAgentChatSenderId("   ")).toBe(DEFAULT_AGENT_CHAT_SENDER_ID);
  });
});
