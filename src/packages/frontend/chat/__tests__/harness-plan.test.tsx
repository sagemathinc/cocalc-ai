import { render, screen } from "@testing-library/react";
import { codexEventsToMarkdown } from "../codex-activity";
import { HarnessPlanRow, updateHarnessPlan } from "../harness-plan";
import type { HarnessPlanEntry } from "../harness-plan";

const plan = (entries: object[]): any => ({
  type: "harness",
  kind: "update",
  source: "acp",
  data: { sessionUpdate: "plan", entries },
});

test("one checklist shows the latest task list where it last changed", () => {
  const state: { current?: HarnessPlanEntry } = {};
  const entry = updateHarnessPlan(
    plan([
      { content: "Find the paper", status: "in_progress", priority: "medium" },
      { content: "Summarize it", status: "pending", priority: "medium" },
    ]),
    state,
    3,
    1000,
  );
  expect(entry).toMatchObject({ kind: "harness-plan", seq: 3 });
  // Later snapshots update the same row instead of adding rows.
  expect(
    updateHarnessPlan(
      plan([
        { content: "Find the paper", status: "completed" },
        { content: "Summarize it", status: "in_progress" },
      ]),
      state,
      9,
      2000,
    ),
  ).toBeUndefined();
  expect(state.current).toMatchObject({ seq: 9, time: 2000 });
  render(<HarnessPlanRow entry={state.current!} />);
  expect(screen.getByText("1 of 2 done")).toBeTruthy();
  expect(screen.getByText("Summarize it")).toBeTruthy();
});

test("other harness updates are not plans", () => {
  const state = {};
  expect(
    updateHarnessPlan(
      {
        type: "harness",
        kind: "update",
        source: "acp",
        data: { sessionUpdate: "tool_call", toolCallId: "a" },
      } as any,
      state,
      1,
    ),
  ).toBe(false);
});

test("the activity export lists the final task states", () => {
  const markdown = codexEventsToMarkdown([
    {
      type: "event",
      seq: 1,
      event: plan([{ content: "Search", status: "in_progress" }]),
    },
    {
      type: "event",
      seq: 2,
      event: plan([
        { content: "Search", status: "completed" },
        { content: "Reply", status: "in_progress" },
      ]),
    },
  ] as any);
  expect(markdown).toContain(
    "- Tasks:\n  - [x] Search\n  - [ ] Reply (in progress)",
  );
  expect(markdown.match(/- Tasks:/g)).toHaveLength(1);
});
