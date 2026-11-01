import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HarnessToolRow, updateHarnessTool } from "../harness-tool";
import type { HarnessToolEntry } from "../harness-tool";

const event = (data: object): any => ({
  type: "harness",
  kind: "update",
  source: "acp",
  data,
});

function projectCommand(
  result: unknown,
  title = "mcp__cocalc_project_3c886f4fa5a1__project_exec",
) {
  const tools = new Map<string, HarnessToolEntry>();
  const entry = updateHarnessTool(
    event({
      sessionUpdate: "tool_call",
      toolCallId: "exec",
      title,
      status: "in_progress",
      rawInput: { script: "git diff --stat", cwd: "/home/user/repo" },
    }),
    tools,
    1,
  )!;
  updateHarnessTool(
    event({
      sessionUpdate: "tool_call_update",
      toolCallId: "exec",
      status: "completed",
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: typeof result === "string" ? result : JSON.stringify(result),
          },
        },
      ],
    }),
    tools,
    2,
  );
  return { entry, tools };
}

test("project exec renders shell input and decoded output with expandable fenced previews", async () => {
  const stdout = Array.from({ length: 30 }, (_, i) => `output line ${i}`).join(
    "\n",
  );
  const { entry } = projectCommand({
    job_id: "job-a",
    status: "completed",
    code: 2,
    stdout,
    stderr: "test failed\n",
  });
  const { container } = render(<HarnessToolRow entry={entry} />);
  expect(screen.getByText(/Project command · completed · exit 2/)).toBeTruthy();
  expect(container.textContent).toContain("cwd /home/user/repo");
  const input = screen.getByRole("region", { name: "Project command input" });
  expect(input.textContent).toContain("git diff --stat");
  expect(input.querySelector("pre.cocalc-slate-code-block")).toBeTruthy();
  const output = screen.getByRole("region", { name: "Project command output" });
  expect(output.textContent).not.toContain('"stdout"');
  const expand = within(output).getByRole("button", { name: /hidden/ });
  expand.focus();
  await userEvent.setup().keyboard("{Enter}");
  expect(within(output).queryByRole("button", { name: /hidden/ })).toBeNull();
  expect(
    screen.getByRole("region", { name: "Project command stderr" }).textContent,
  ).toContain("test failed");
});

test("result decoding happens before display truncation and replacement updates discard stale results", () => {
  const { entry, tools } = projectCommand({
    stdout: "x".repeat(40000),
    stderr: "",
    code: 0,
  });
  expect(entry.input?.script).toBe("git diff --stat");
  expect(entry.result?.stdout.length).toBeLessThan(33000);
  expect(entry.result?.stdout).toContain("[truncated]");
  updateHarnessTool(
    event({
      sessionUpdate: "tool_call_update",
      toolCallId: "exec",
      status: "failed",
    }),
    tools,
    3,
  );
  expect(entry.result?.code).toBe(0);
  updateHarnessTool(
    event({
      sessionUpdate: "tool_call_update",
      toolCallId: "exec",
      content: [
        { type: "content", content: { type: "text", text: "not json" } },
      ],
    }),
    tools,
    4,
  );
  expect(entry.result).toBeUndefined();
  expect(entry.output).toBe("not json");
});

test("legacy names and wait results preserve job state, pagination and cleanup warnings", () => {
  const { entry } = projectCommand(
    {
      job_id: "job-a",
      status: "running",
      stdout: "",
      stderr: "",
      output_truncated: true,
      has_more: true,
      cleanup_pending: true,
      cleanup_error: "Cleanup unconfirmed",
    },
    "mcp__cocalc_project__project_exec_wait",
  );
  render(<HarnessToolRow entry={entry} />);
  expect(
    screen.getByText("Wait for project command · running", { exact: false }),
  ).toBeTruthy();
  expect(screen.getByText("Output truncated")).toBeTruthy();
  expect(screen.getByText("Job cleanup pending")).toBeTruthy();
  expect(screen.getByText(/More output available/)).toBeTruthy();
  expect(
    screen.getByRole("region", { name: "Project command cleanup error" })
      .textContent,
  ).toContain("Cleanup unconfirmed");
});

test.each(["{bad json", "`````\n<img src=x onerror=alert(1)>\n`````"])(
  "unrecognized execution output stays literal: %s",
  (output) => {
    const { entry } = projectCommand(output);
    const { container } = render(<HarnessToolRow entry={entry} />);
    expect(entry.result).toBeUndefined();
    expect(container.querySelector("img")).toBeNull();
    expect(
      screen
        .getByRole("region", { name: "Project command output" })
        .querySelector("pre.cocalc-slate-code-block"),
    ).toBeTruthy();
  },
);

test("raw MCP output is decoded without confusing other MCP servers with project commands", () => {
  const { entry, tools } = projectCommand({ stdout: "old", code: 0 });
  updateHarnessTool(
    event({
      sessionUpdate: "tool_call_update",
      toolCallId: "exec",
      rawOutput: [
        {
          type: "text",
          text: JSON.stringify({ stdout: "new\noutput", stderr: "", code: 0 }),
        },
      ],
    }),
    tools,
    3,
  );
  expect(entry.result?.stdout).toBe("new\noutput");
  expect(entry.input?.script).toBe("git diff --stat");
  const other = projectCommand(
    { stdout: "not a project command", code: 0 },
    "mcp__other__project_exec",
  ).entry;
  expect(other.result).toBeUndefined();
  expect(other.input).toBeUndefined();
});

test("tool updates merge by ID without fabricating completion or duplicating output", () => {
  const tools = new Map<string, HarnessToolEntry>();
  const first = updateHarnessTool(
    event({
      sessionUpdate: "tool_call",
      toolCallId: "a",
      title: "Read file",
      status: "in_progress",
      content: [{ type: "content", content: { type: "text", text: "first" } }],
    }),
    tools,
    1,
  )!;
  expect(first.status).toBe("in progress");
  expect(
    updateHarnessTool(
      event({
        sessionUpdate: "tool_call_update",
        toolCallId: "a",
        status: "completed",
      }),
      tools,
      2,
    ),
  ).toBeUndefined();
  expect(first.output).toBe("first");
  expect(first.status).toBe("completed");
  updateHarnessTool(
    event({
      sessionUpdate: "tool_call_update",
      toolCallId: "a",
      content: [
        { type: "content", content: { type: "text", text: "replacement" } },
      ],
    }),
    tools,
    3,
  );
  expect(first.output).toBe("replacement");
  const missing = updateHarnessTool(
    event({
      sessionUpdate: "tool_call_update",
      toolCallId: "b",
      title: "Late update",
    }),
    tools,
    4,
  )!;
  expect(missing.status).toBe("unknown");
  expect(tools.size).toBe(2);
});

test("untrusted metadata is bounded and non-text content does not become executable HTML", async () => {
  const tools = new Map<string, HarnessToolEntry>();
  const entry = updateHarnessTool(
    event({
      sessionUpdate: "tool_call",
      toolCallId: "a",
      title: "Inspect output",
      status: "failed",
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: "<img src=x onerror=alert(1)>".repeat(3000),
          },
        },
      ],
    }),
    tools,
    1,
  )!;
  expect(entry.output.length).toBeLessThan(33000);
  expect(entry.output).toContain("[truncated]");
  const { container } = render(<HarnessToolRow entry={entry} />);
  const summary = screen.getByText("Inspect output · failed");
  await userEvent.setup().tab();
  expect(document.activeElement).toBe(summary);
  expect(container.querySelector("img")).toBeNull();
  expect(
    updateHarnessTool(
      event({ sessionUpdate: "tool_call", toolCallId: "x".repeat(1025) }),
      tools,
      2,
    ),
  ).toBeUndefined();
});

test("expanded tool output is named and keyboard reachable", async () => {
  const user = userEvent.setup();
  render(
    <>
      <HarnessToolRow
        entry={{
          kind: "harness-tool",
          id: "tool",
          seq: 1,
          title: "Run checks",
          status: "failed",
          output: "Failure details\n".repeat(100),
        }}
      />
      <button>Next control</button>
    </>,
  );
  const summary = screen.getByText("Run checks · failed");
  await user.tab();
  expect(document.activeElement).toBe(summary);
  await user.click(summary);
  const output = screen.getByRole("region", { name: "Run checks output" });
  await user.tab();
  expect(document.activeElement).toBe(output);
  await user.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Next control" }),
  );
});

// The updates claude-agent-acp 0.93 sent for one Agent call in a recorded
// staging2 turn (trimmed): the launch, its title, its input, then a child.
function recordedSubagent(withTitleUpdate: boolean) {
  const tools = new Map<string, HarnessToolEntry>();
  const updates = [
    {
      sessionUpdate: "tool_call",
      toolCallId: "toolu_agent",
      title: "Task",
      kind: "think",
      status: "pending",
      content: [],
      _meta: {
        claudeCode: { toolName: "Agent" },
        jetbrains: { air: { version: 1, subagent: true } },
      },
    },
    ...(withTitleUpdate
      ? [
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "toolu_agent",
            title: "List 5 largest files in home",
            _meta: {},
          },
        ]
      : []),
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_agent",
      rawInput: {
        description: "List 5 largest files in home",
        subagent_type: "general-purpose",
        run_in_background: false,
        prompt: "Read-only task. List the 5 largest files under /home/user.",
      },
      _meta: {},
    },
    {
      sessionUpdate: "tool_call",
      toolCallId: "toolu_child",
      title: "find /home/user -type f | sort -rn | head -5",
      kind: "execute",
      status: "pending",
      _meta: {
        claudeCode: { toolName: "Bash", parentToolUseId: "toolu_agent" },
      },
    },
  ];
  updates.forEach((update, i) => updateHarnessTool(event(update), tools, i + 1));
  return tools;
}

test.each([true, false])(
  "a Claude subagent's tool calls render under its task (title update sent: %s)",
  (withTitleUpdate) => {
    const tools = recordedSubagent(withTitleUpdate);
    const child = tools.get("toolu_child")!;
    expect(child).toMatchObject({
      parentId: "toolu_agent",
      parentTitle: "List 5 largest files in home",
    });
    // A later update can't re-parent the call.
    updateHarnessTool(
      event({
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_child",
        status: "completed",
        _meta: { claudeCode: { parentToolUseId: "other" } },
      }),
      tools,
      99,
    );
    expect(tools.get("toolu_child")!.parentId).toBe("toolu_agent");
    const { unmount } = render(<HarnessToolRow entry={child} />);
    const group = screen.getByLabelText("Subagent tool call");
    expect(
      within(group).getByText("Subagent: List 5 largest files in home"),
    ).toBeTruthy();
    expect(within(group).getByText(/find \/home\/user/)).toBeTruthy();
    unmount();
    // The Agent call itself is an ordinary row.
    render(<HarnessToolRow entry={tools.get("toolu_agent")!} />);
    expect(screen.queryByLabelText("Subagent tool call")).toBeNull();
  },
);

test("a subagent's streamed text is shown with its Agent call, not dropped", async () => {
  const tools = recordedSubagent(true);
  const stamp = { claudeCode: { parentToolUseId: "toolu_agent" } };
  for (const [i, text] of ["Looking at ", "the home directory."].entries())
    expect(
      updateHarnessTool(
        event({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
          _meta: stamp,
        }),
        tools,
        10 + i,
      ),
    ).toBeUndefined();
  // Unstamped or orphaned chunks change nothing.
  updateHarnessTool(
    event({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "orphan" },
      _meta: { claudeCode: { parentToolUseId: "missing" } },
    }),
    tools,
    20,
  );
  const agent = tools.get("toolu_agent")!;
  expect(agent.narration).toBe("Looking at the home directory.");
  render(<HarnessToolRow entry={agent} />);
  await userEvent.click(screen.getByText(/List 5 largest files in home/));
  expect(
    screen.getByRole("region", {
      name: "List 5 largest files in home subagent narration",
    }).textContent,
  ).toBe("Looking at the home directory.");
});
