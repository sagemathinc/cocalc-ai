import {
  ClaudeSubagentTracker,
  claudeParentToolUseId,
} from "./claude-subagents";

const agentCall = (id: string) => ({
  sessionUpdate: "tool_call",
  toolCallId: id,
  title: "Task",
  status: "pending",
  _meta: { claudeCode: { toolName: "Agent" } },
});

describe("Claude subagents", () => {
  it("ignores tool calls that aren't Agent calls, and updates of unknown calls", () => {
    const tracker = new ClaudeSubagentTracker();
    expect(
      tracker.observe({
        sessionUpdate: "tool_call",
        toolCallId: "bash",
        status: "pending",
        _meta: { claudeCode: { toolName: "Bash" } },
      }),
    ).toBeUndefined();
    expect(
      tracker.observe({
        sessionUpdate: "tool_call_update",
        toolCallId: "bash",
        status: "completed",
      }),
    ).toBeUndefined();
    expect(
      tracker.observe({ sessionUpdate: "agent_message_chunk" }),
    ).toBeUndefined();
  });

  it("follows an Agent call to failure, with its task and outcome", () => {
    const tracker = new ClaudeSubagentTracker();
    expect(tracker.observe(agentCall("a"))).toMatchObject({
      threadId: "a",
      state: "running",
      tool: "spawn",
    });
    tracker.observe({
      sessionUpdate: "tool_call_update",
      toolCallId: "a",
      rawInput: { prompt: "x".repeat(5000), model: "haiku" },
    });
    const failed = tracker.observe({
      sessionUpdate: "tool_call_update",
      toolCallId: "a",
      status: "failed",
      content: [{ type: "content", content: { type: "text", text: "boom" } }],
    });
    expect(failed).toMatchObject({ state: "failed", message: "boom", model: "haiku" });
    expect(failed!.task!.length).toBe(2003); // bounded, with "..."
    expect(tracker.finish("end_turn")).toEqual([]);
  });

  it("reports subagents without an outcome when the turn ends", () => {
    const tracker = new ClaudeSubagentTracker();
    tracker.observe(agentCall("a"));
    tracker.observe(agentCall("b"));
    tracker.observe({
      sessionUpdate: "tool_call_update",
      toolCallId: "b",
      status: "completed",
    });
    expect(tracker.finish("cancelled")).toEqual([
      expect.objectContaining({ threadId: "a", state: "interrupted" }),
    ]);
    const other = new ClaudeSubagentTracker();
    other.observe(agentCall("c"));
    expect(other.finish("end_turn")).toEqual([
      expect.objectContaining({ threadId: "c", state: "unknown" }),
    ]);
  });

  it("reads the parent stamp only when it's a sane id", () => {
    expect(
      claudeParentToolUseId({ _meta: { claudeCode: { parentToolUseId: "p" } } }),
    ).toBe("p");
    expect(claudeParentToolUseId({ _meta: { claudeCode: { parentToolUseId: 3 } } })).toBeUndefined();
    expect(claudeParentToolUseId({})).toBeUndefined();
    expect(
      claudeParentToolUseId({
        _meta: { claudeCode: { parentToolUseId: "x".repeat(2000) } },
      }),
    ).toBeUndefined();
  });
});
