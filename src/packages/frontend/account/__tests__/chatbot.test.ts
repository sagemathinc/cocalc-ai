/** @jest-environment jsdom */

import { chatBotName, isChatBot } from "../chatbot";

describe("codex chatbot identity", () => {
  it("treats codex model ids as chatbots", () => {
    expect(isChatBot("gpt-5.1-codex-mini")).toBe(true);
    expect(isChatBot("gpt-5.3-codex")).toBe(true);
    expect(isChatBot("gpt-5.4")).toBe(true);
    expect(isChatBot("gpt-5.5")).toBe(true);
    expect(isChatBot("gpt-5.4-mini")).toBe(true);
    expect(isChatBot("gpt-5.3-codex-spark")).toBe(true);
    expect(isChatBot("openai-codex-agent")).toBe(true);
  });

  it("does not treat non-codex provider ids as chatbots anymore", () => {
    expect(isChatBot("chatgpt")).toBe(false);
    expect(isChatBot("openai-gpt-4o")).toBe(false);
    expect(isChatBot("google-gemini-2.5-pro")).toBe(false);
  });

  it("renders codex model names with model id in chat", () => {
    expect(chatBotName("gpt-5.1-codex-mini")).toBe(
      "Codex Agent (gpt-5.1-codex-mini)",
    );
    expect(chatBotName("gpt-5.3-codex")).toBe("Codex Agent (gpt-5.3-codex)");
    expect(chatBotName("gpt-5.4")).toBe("Codex Agent (gpt-5.4)");
    expect(chatBotName("gpt-5.5")).toBe("Codex Agent (gpt-5.5)");
    expect(chatBotName("gpt-5.4-mini")).toBe("Codex Agent (gpt-5.4-mini)");
    expect(chatBotName("gpt-5.3-codex-spark")).toBe(
      "Codex Agent (gpt-5.3-codex-spark)",
    );
    expect(chatBotName("openai-codex-agent")).toBe("Codex Agent");
  });
});
