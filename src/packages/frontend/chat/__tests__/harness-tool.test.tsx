import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HarnessToolRow, updateHarnessTool } from "../harness-tool";
import type { HarnessToolEntry } from "../harness-tool";

const event = (data: object): any => ({
  type: "harness",
  kind: "update",
  source: "acp",
  data,
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
