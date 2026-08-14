import { normalizeCodexMaxConcurrentSubagents } from "../codex-subagent-concurrency";

describe("normalizeCodexMaxConcurrentSubagents", () => {
  it("leaves automatic and invalid values unset", () => {
    expect(normalizeCodexMaxConcurrentSubagents(undefined)).toBeUndefined();
    expect(normalizeCodexMaxConcurrentSubagents("automatic")).toBeUndefined();
    expect(normalizeCodexMaxConcurrentSubagents("nope")).toBeUndefined();
    expect(normalizeCodexMaxConcurrentSubagents(1.5)).toBeUndefined();
  });

  it("accepts ordinary values and clamps browser input", () => {
    expect(normalizeCodexMaxConcurrentSubagents(1)).toBe(1);
    expect(normalizeCodexMaxConcurrentSubagents("10")).toBe(10);
    expect(normalizeCodexMaxConcurrentSubagents(0)).toBe(1);
    expect(normalizeCodexMaxConcurrentSubagents(100)).toBe(16);
  });
});
