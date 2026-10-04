import {
  agentRuntimeFromProfile,
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
