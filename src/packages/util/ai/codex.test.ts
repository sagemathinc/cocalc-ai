import { DEFAULT_CODEX_MODELS, isCodexModelName } from "./codex";

describe("DEFAULT_CODEX_MODELS", () => {
  it("includes gpt-5.4-mini as a supported codex model", () => {
    expect(DEFAULT_CODEX_MODELS.map((model) => model.name)).toContain(
      "gpt-5.4-mini",
    );
  });

  it("recognizes gpt-5.4-mini as a codex model name", () => {
    expect(isCodexModelName("gpt-5.4-mini")).toBe(true);
  });
});
