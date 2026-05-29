import {
  codexServiceTierForAppServer,
  DEFAULT_CODEX_MODELS,
  isCodexModelName,
  resolveCodexServiceTier,
} from "./codex";

describe("DEFAULT_CODEX_MODELS", () => {
  it("matches the current Codex CLI model list order", () => {
    expect(DEFAULT_CODEX_MODELS.map((model) => model.name)).toEqual([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
      "gpt-5.2",
    ]);
  });

  it("recognizes gpt-5.5 as a codex model name", () => {
    expect(isCodexModelName("gpt-5.5")).toBe(true);
  });

  it("defaults gpt-5.5 to medium reasoning", () => {
    expect(DEFAULT_CODEX_MODELS[0]).toMatchObject({
      name: "gpt-5.5",
      reasoning: expect.arrayContaining([
        expect.objectContaining({ id: "medium", default: true }),
      ]),
    });
  });

  it("only enables fast service tier for models that support it", () => {
    expect(
      resolveCodexServiceTier({
        model: "gpt-5.5",
        serviceTier: "fast",
      }),
    ).toBe("fast");
    expect(
      codexServiceTierForAppServer({
        model: "gpt-5.5",
        serviceTier: "fast",
      }),
    ).toBe("priority");
    expect(
      resolveCodexServiceTier({
        model: "gpt-5.3-codex",
        serviceTier: "fast",
      }),
    ).toBe("standard");
    expect(codexServiceTierForAppServer({ model: "gpt-5.5" })).toBe(null);
  });
});
