import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CodexGoalControl } from "../codex-goal";
import type { CodexGoalSnapshot } from "@cocalc/util/ai/codex-goal";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getActions: () => ({ erase_active_key_handler: jest.fn() }) },
}));

const snapshot: CodexGoalSnapshot = {
  sessionId: "session",
  observedAt: 100,
  goal: {
    objective: "Finish the implementation",
    status: "active",
    tokenBudget: null,
    tokensUsed: 100,
    timeUsedSeconds: 60,
    updatedAt: 1,
  },
};

const getComputedStyle = window.getComputedStyle;
beforeAll(() => {
  window.getComputedStyle = (element) => getComputedStyle(element);
});
afterAll(() => {
  window.getComputedStyle = getComputedStyle;
});

it("renders the stored goal without calling the runtime or saving anything", () => {
  const onChange = jest.fn();
  render(<CodexGoalControl snapshot={snapshot} onChange={onChange} />);
  const trigger = screen.getByRole("button", {
    name: "Goal: Finish the implementation (active)",
  });
  expect(trigger).toBeTruthy();
  expect(trigger.style.color).toBe(UI_COLORS.text);
  expect(screen.getByText("(active)").style.color).toBe(UI_COLORS.secondary);
  expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
  expect(onChange).not.toHaveBeenCalled();
});

it("opens with the keyboard, labels inputs, and restores focus after Escape", async () => {
  const user = userEvent.setup();
  render(<CodexGoalControl onChange={jest.fn()} />);
  const trigger = screen.getByRole("button", { name: "Set goal" });
  trigger.focus();
  await user.keyboard("{Enter}");
  const dialog = await screen.findByRole("dialog", { name: "Goal" });
  expect(
    screen.getByRole("textbox", { name: "What should Codex accomplish?" }),
  ).toBeTruthy();
  expect(dialog.querySelector("[data-cocalc-keyboard-boundary]")).toBeTruthy();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

it("saves an explicit objective and optional budget", async () => {
  const user = userEvent.setup();
  const onChange = jest.fn(async () => {});
  render(<CodexGoalControl onChange={onChange} />);
  await user.click(screen.getByRole("button", { name: "Set goal" }));
  await user.type(
    screen.getByRole("textbox", { name: "What should Codex accomplish?" }),
    "Finish it",
  );
  await user.click(screen.getByText("Budget and usage"));
  await user.type(
    screen.getByRole("textbox", { name: "Token budget (optional)" }),
    "2000",
  );
  await user.click(screen.getByRole("button", { name: "Save goal" }));
  expect(onChange).toHaveBeenCalledWith({
    action: "set",
    objective: "Finish it",
    tokenBudget: 2000,
    status: "active",
  });
});

it("does not implicitly reactivate a paused/blocked goal when editing its objective", async () => {
  const onChange = jest.fn(async () => {});
  render(
    <CodexGoalControl
      snapshot={{ ...snapshot, goal: { ...snapshot.goal!, status: "blocked" } }}
      onChange={onChange}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Goal:/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save goal" }));
  await waitFor(() =>
    expect(onChange).toHaveBeenCalledWith({
      action: "set",
      objective: snapshot.goal!.objective,
      tokenBudget: null,
    }),
  );
});

it("sends a pause command without rewriting objective or budget", async () => {
  const onChange = jest.fn(async () => {});
  render(<CodexGoalControl snapshot={snapshot} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "Pause" }));
  await waitFor(() =>
    expect(onChange).toHaveBeenCalledWith({ action: "set", status: "paused" }),
  );
});

it("shows pending changes and does not confuse them with confirmed runtime state", () => {
  render(
    <CodexGoalControl
      snapshot={snapshot}
      request={{ id: "new", action: "clear" }}
      onChange={jest.fn()}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Goal: No goal (pending)" }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
});

it("shows crash-window commands as awaiting confirmation and allows an explicit retry", () => {
  render(
    <CodexGoalControl
      snapshot={snapshot}
      request={{ id: "new", action: "set", objective: "New goal" }}
      ack={{ id: "new", state: "applying" }}
      onChange={jest.fn()}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "Goal: New goal (awaiting confirmation)",
    }),
  );
  expect(screen.getByRole("button", { name: "Save goal" })).toBeTruthy();
});

it("announces a failed initial goal change from the trigger", () => {
  render(
    <CodexGoalControl
      request={{ id: "failed", action: "set", objective: "First goal" }}
      ack={{ id: "failed", state: "error", error: "runtime unavailable" }}
      onChange={jest.fn()}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Set goal (change failed)" }),
  ).toBeTruthy();
});

it("rejects invalid budgets accessibly and clears only on an explicit action", async () => {
  const onChange = jest.fn(async () => {});
  render(<CodexGoalControl snapshot={snapshot} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: /Goal:/ }));
  fireEvent.click(screen.getByText("Budget and usage"));
  fireEvent.change(
    screen.getByRole("textbox", { name: "Token budget (optional)" }),
    { target: { value: "-1" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Save goal" }));
  expect(screen.getByRole("alert").textContent).toContain("positive integer");
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Clear goal" }));
  await waitFor(() =>
    expect(onChange).toHaveBeenCalledWith({ action: "clear" }),
  );
});
