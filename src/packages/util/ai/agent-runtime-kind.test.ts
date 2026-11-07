import {
  agentModelLabel,
  agentRuntimeFromProfile,
  mergeAgentRuntime,
  agentRuntimeFromThread,
  agentRuntimeLabel,
  parseAgentRuntimeSummary,
  sameAgentRuntime,
} from "./agent-runtime-kind";

test("derives the runtime from a chat thread's configuration", () => {
  expect(
    agentRuntimeFromThread({
      agent_runtime: { profile: { version: 2, id: "claude-code" } },
    }),
  ).toEqual({ kind: "claude-code" });
  expect(
    agentRuntimeFromThread({
      agent_runtime: { profile: { version: 1, id: "pi" } },
    }),
  ).toEqual({ kind: "acp", name: "pi" });
  expect(agentRuntimeFromThread({ agent_kind: "acp" })).toEqual({
    kind: "codex",
  });
  expect(agentRuntimeFromThread({ acp_config: {} })).toEqual({ kind: "codex" });
  expect(agentRuntimeFromThread({ agent_kind: "llm" })).toBeUndefined();
  expect(agentRuntimeFromProfile(undefined)).toEqual({ kind: "codex" });
});

test("parses only known runtime kinds", () => {
  expect(parseAgentRuntimeSummary({ kind: "codex" })).toEqual({
    kind: "codex",
  });
  expect(parseAgentRuntimeSummary({ kind: "acp", name: " pi " })).toEqual({
    kind: "acp",
    name: "pi",
  });
  expect(parseAgentRuntimeSummary({ kind: "shell" })).toBeUndefined();
  expect(parseAgentRuntimeSummary(null)).toBeUndefined();
});

test("labels and comparison", () => {
  expect(agentRuntimeLabel({ kind: "claude-code" })).toBe("Claude Code");
  expect(agentRuntimeLabel({ kind: "acp", name: "pi" })).toBe("ACP: pi");
  expect(sameAgentRuntime({ kind: "codex" }, { kind: "codex" })).toBe(true);
  expect(sameAgentRuntime(null, { kind: "codex" })).toBe(false);
});

// A Claude thread that was a Codex thread before: its Codex fields remain.
const claudeThread = {
  agent_kind: "acp",
  agent_model: "gpt-6-luna",
  acp_config: { model: "gpt-6-luna", reasoning: "medium" },
  agent_runtime: {
    profile: { version: 2, id: "claude-code" },
    settings: {
      configOptions: [
        { id: "model", value: "sonnet" },
        { id: "effort", value: "low" },
      ],
    },
  },
};

test("a Claude thread's model comes from its harness, never its old Codex fields", () => {
  // Saved settings only (no controls reported yet): values, no names.
  expect(agentRuntimeFromThread(claudeThread)).toEqual({
    kind: "claude-code",
    model: "sonnet",
    effort: "low",
  });
  // The harness's own controls win, with its display name.
  const controls = {
    profile: { version: 2, id: "claude-code" },
    controls: {
      configOptions: [
        {
          id: "model",
          currentValue: "opus",
          options: [{ value: "opus", name: "Opus 5.5" }],
        },
        { id: "effort", currentValue: "high", options: [] },
      ],
    },
  };
  expect(
    agentRuntimeFromThread({
      ...claudeThread,
      agent_runtime_controls: controls,
    }),
  ).toEqual({
    kind: "claude-code",
    model: "opus",
    model_name: "Opus 5.5",
    effort: "high",
  });
  // Controls another harness reported (before a switch) don't apply.
  expect(
    agentRuntimeFromThread({
      ...claudeThread,
      agent_runtime_controls: {
        ...controls,
        profile: { version: 1, id: "pi" },
      },
    }),
  ).toEqual({ kind: "claude-code", model: "sonnet", effort: "low" });
  // "default" names no model.
  expect(
    agentRuntimeFromThread({
      agent_runtime: {
        profile: { version: 2, id: "claude-code" },
        settings: { configOptions: [{ id: "model", value: "default" }] },
      },
    }),
  ).toEqual({ kind: "claude-code" });
});

test("a Codex thread's model and reasoning", () => {
  expect(
    agentRuntimeFromThread({
      acp_config: { model: "gpt-6-luna", reasoning: "xhigh" },
    }),
  ).toEqual({ kind: "codex", model: "gpt-6-luna", effort: "xhigh" });
  expect(agentRuntimeFromThread({ agent_model: "gpt-6-luna" })).toEqual({
    kind: "codex",
    model: "gpt-6-luna",
  });
});

test("model fields are bounded one-line text", () => {
  expect(
    parseAgentRuntimeSummary({
      kind: "claude-code",
      model: " opus\n ",
      model_name: "x".repeat(500),
      effort: 7,
    }),
  ).toEqual({
    kind: "claude-code",
    model: "opus",
    model_name: "x".repeat(100),
  });
  // A display name without a model says nothing.
  expect(
    parseAgentRuntimeSummary({ kind: "codex", model_name: "GPT" }),
  ).toEqual({ kind: "codex" });
});

test("merging a report keeps a known model only for the same runtime", () => {
  const opus = { kind: "claude-code" as const, model: "opus", effort: "high" };
  expect(mergeAgentRuntime(opus, { kind: "claude-code" })).toEqual(opus);
  expect(mergeAgentRuntime(opus, { kind: "codex" })).toEqual({ kind: "codex" });
  expect(
    mergeAgentRuntime(opus, { kind: "claude-code", model: "sonnet" }),
  ).toEqual({ kind: "claude-code", model: "sonnet" });
  expect(mergeAgentRuntime(null, { kind: "codex" })).toEqual({ kind: "codex" });
  expect(sameAgentRuntime(opus, { kind: "claude-code" })).toBe(false);
});

test("model labels", () => {
  expect(
    agentModelLabel({
      kind: "claude-code",
      model: "opus",
      model_name: "Opus 5.5",
    }),
  ).toBe("Opus 5.5 (opus)");
  expect(agentModelLabel({ kind: "codex", model: "gpt-6-luna" })).toBe(
    "gpt-6-luna",
  );
  expect(agentModelLabel({ kind: "codex" })).toBeUndefined();
});
