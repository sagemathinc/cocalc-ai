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
