/** @jest-environment jsdom */

import { chatBotName, codexAgentName, isChatBot } from "../chatbot";

describe("codex chatbot identity", () => {
  it("treats codex model ids as chatbots", () => {
    expect(isChatBot("gpt-5.1-codex-mini")).toBe(true);
    expect(isChatBot("gpt-5.3-codex")).toBe(true);
    expect(isChatBot("gpt-5.4")).toBe(true);
    expect(isChatBot("gpt-5.6")).toBe(true);
    expect(isChatBot("gpt-5.6-sol")).toBe(true);
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
    expect(chatBotName("gpt-5.6")).toBe("Codex Agent (gpt-5.6)");
    expect(chatBotName("gpt-5.6-sol")).toBe("Codex Agent (gpt-5.6-sol)");
    expect(chatBotName("gpt-5.5")).toBe("Codex Agent (gpt-5.5)");
    expect(chatBotName("gpt-5.4-mini")).toBe("Codex Agent (gpt-5.4-mini)");
    expect(chatBotName("gpt-5.3-codex-spark")).toBe(
      "Codex Agent (gpt-5.3-codex-spark)",
    );
    expect(chatBotName("openai-codex-agent")).toBe("Codex Agent");
  });

  it("renders dynamically advertised model ids in trusted codex threads", () => {
    expect(codexAgentName("gpt-daybreak-blue-latest")).toBe(
      "Codex Agent (gpt-daybreak-blue-latest)",
    );
    expect(codexAgentName("codex-agent")).toBe("Codex Agent");
  });
});
