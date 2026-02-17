/** @jest-environment jsdom */

import { chatBotName, isChatBot } from "../chatbot";

describe("codex chatbot identity", () => {
  it("treats codex model ids as chatbots", () => {
    expect(isChatBot("gpt-5.1-codex-mini")).toBe(true);
    expect(isChatBot("gpt-5.3-codex")).toBe(true);
    expect(isChatBot("gpt-5.3-codex-spark")).toBe(true);
  });

  it("renders codex model names with model id in chat", () => {
    expect(chatBotName("gpt-5.1-codex-mini")).toBe(
      "Codex Agent (gpt-5.1-codex-mini)",
    );
    expect(chatBotName("gpt-5.3-codex")).toBe("Codex Agent (gpt-5.3-codex)");
    expect(chatBotName("gpt-5.3-codex-spark")).toBe(
      "Codex Agent (gpt-5.3-codex-spark)",
    );
    expect(chatBotName("openai-codex-agent")).toBe("Codex Agent");
  });
});
