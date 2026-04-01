import {
  DEFAULT_AUTOMATION_CHAT_SENDER_ID,
  resolveAutomationChatSenderId,
} from "../automation-chat-sender";

describe("automation chat sender", () => {
  it("uses the thread agent model when available", () => {
    expect(resolveAutomationChatSenderId("gpt-5.4")).toBe("gpt-5.4");
  });

  it("falls back to the default codex sender when the model is missing", () => {
    expect(resolveAutomationChatSenderId(undefined)).toBe(
      DEFAULT_AUTOMATION_CHAT_SENDER_ID,
    );
    expect(resolveAutomationChatSenderId("   ")).toBe(
      DEFAULT_AUTOMATION_CHAT_SENDER_ID,
    );
  });
});
