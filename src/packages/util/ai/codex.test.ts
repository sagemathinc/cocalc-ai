import { DEFAULT_CODEX_MODELS, isCodexModelName } from "./codex";

describe("DEFAULT_CODEX_MODELS", () => {
  it("matches the current Codex CLI model list order", () => {
    expect(DEFAULT_CODEX_MODELS.map((model) => model.name)).toEqual([
      "gpt-5.4",
      "gpt-5.5",
      "gpt-5.4-mini",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
      "gpt-5.2",
    ]);
  });

  it("recognizes gpt-5.5 as a codex model name", () => {
    expect(isCodexModelName("gpt-5.5")).toBe(true);
  });
});
