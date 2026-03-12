import { ensureLoopContractPrompt } from "../loop-contract";

describe("ACP loop prompt contract", () => {
  it("adds the loop contract when loop mode is enabled", () => {
    const prompt = ensureLoopContractPrompt("do work", {
      enabled: true,
      max_turns: 5,
      max_wall_time_ms: 30 * 60_000,
    });
    expect(prompt).toContain("System loop contract (required):");
    expect(prompt).toContain('"loop":{"rerun":true|false');
  });

  it("does not duplicate the loop contract for later iterations", () => {
    const once = ensureLoopContractPrompt("do work", {
      enabled: true,
      max_turns: 5,
      max_wall_time_ms: 30 * 60_000,
    });
    const twice = ensureLoopContractPrompt(once, {
      enabled: true,
      max_turns: 5,
      max_wall_time_ms: 30 * 60_000,
    });
    expect(
      twice.match(/System loop contract \(required\):/g)?.length ?? 0,
    ).toBe(1);
  });
});
