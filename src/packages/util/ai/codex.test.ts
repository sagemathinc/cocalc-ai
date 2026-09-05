import {
  codexServiceTierForAppServer,
  DEFAULT_CODEX_MODELS,
  isCodexModelName,
  resolveCodexServiceTier,
} from "./codex";

describe("DEFAULT_CODEX_MODELS", () => {
  it("matches the current Codex CLI model list order", () => {
    expect(DEFAULT_CODEX_MODELS.map((model) => model.name)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.2",
    ]);
  });

  it("recognizes gpt-5.6 models as codex model names", () => {
    expect(isCodexModelName("gpt-5.6")).toBe(true);
    expect(isCodexModelName("gpt-5.6-sol")).toBe(true);
    expect(isCodexModelName("gpt-5.6-terra")).toBe(true);
    expect(isCodexModelName("gpt-5.6-luna")).toBe(true);
    expect(isCodexModelName("gpt-5.5")).toBe(true);
  });

  it("defaults gpt-5.6-sol to low reasoning", () => {
    expect(DEFAULT_CODEX_MODELS[0]).toMatchObject({
      name: "gpt-5.6-sol",
      reasoning: expect.arrayContaining([
        expect.objectContaining({ id: "low", default: true }),
        expect.objectContaining({ id: "max" }),
        expect.objectContaining({ id: "ultra" }),
      ]),
    });
  });

  it("exposes upstream max reasoning on gpt-5.6 family models", () => {
    const modelReasoning = new Map(
      DEFAULT_CODEX_MODELS.map((model) => [
        model.name,
        model.reasoning?.map((reasoning) => reasoning.id) ?? [],
      ]),
    );
    expect(modelReasoning.get("gpt-5.6-sol")).toEqual([
      "low",
      "medium",
      "high",
      "extra_high",
      "max",
      "ultra",
    ]);
    expect(modelReasoning.get("gpt-5.6-terra")).toEqual([
      "low",
      "medium",
      "high",
      "extra_high",
      "max",
      "ultra",
    ]);
    expect(modelReasoning.get("gpt-5.6-luna")).toEqual([
      "low",
      "medium",
      "high",
      "extra_high",
      "max",
    ]);
  });

  it("only enables fast service tier for models that support it", () => {
    expect(
      resolveCodexServiceTier({
        model: "gpt-5.6-sol",
        serviceTier: "fast",
      }),
    ).toBe("fast");
    expect(
      resolveCodexServiceTier({
        model: "gpt-5.6",
        serviceTier: "fast",
      }),
    ).toBe("fast");
    expect(
      codexServiceTierForAppServer({
        model: "gpt-5.6-sol",
        serviceTier: "fast",
      }),
    ).toBe("fast");
    expect(
      resolveCodexServiceTier({
        model: "gpt-5.4-mini",
        serviceTier: "fast",
      }),
    ).toBe("standard");
    expect(
      resolveCodexServiceTier({
        model: "newly-advertised-model",
        serviceTier: "fast",
      }),
    ).toBe("fast");
    expect(
      codexServiceTierForAppServer({
        model: "newly-advertised-model",
        serviceTier: "fast",
      }),
    ).toBe("fast");
    expect(codexServiceTierForAppServer({ model: "gpt-5.6-sol" })).toBe(null);
  });
});
