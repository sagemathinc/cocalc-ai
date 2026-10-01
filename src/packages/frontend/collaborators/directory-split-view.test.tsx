import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DirectorySplitView } from "./directory-split-view";

jest.mock("@cocalc/frontend/components/icon", () => ({ Icon: () => null }));

let resize: (entries: { contentRect: { width: number } }[]) => void;
const originalObserver = global.ResizeObserver;
beforeEach(() => {
  global.ResizeObserver = class {
    constructor(callback) {
      resize = callback;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as any;
});
afterEach(() => {
  global.ResizeObserver = originalObserver;
});

function Fixture({ selectionKey = "first" }: { selectionKey?: string }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  return (
    <>
      <div ref={setTarget} />
      <DirectorySplitView
        hasDetail
        controlsTarget={target}
        id="split"
        labelledBy="title"
        selectionKey={selectionKey}
      >
        <div>Results</div>
        <textarea aria-label="Draft" defaultValue="Unsent message" />
      </DirectorySplitView>
    </>
  );
}

it("hides and restores results from the keyboard without remounting the draft", async () => {
  const user = userEvent.setup();
  render(<Fixture />);
  const draft = screen.getByRole("textbox", { name: "Draft" });
  const hide = screen.getByRole("button", { name: "Hide results" });
  hide.focus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("button", { name: "Show results" })).toHaveFocus();
  expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft);
  await user.keyboard("{Enter}");
  expect(screen.getByRole("button", { name: "Hide results" })).toHaveFocus();
  expect(draft).toHaveValue("Unsent message");
});

it("offers a non-drag resizing control with Escape focus restoration", async () => {
  const user = userEvent.setup();
  render(<Fixture />);
  const trigger = screen.getByRole("button", { name: "Resize results panel" });
  trigger.focus();
  await user.keyboard("{Enter}");
  const range = screen.getByRole("slider", { name: "Results panel width" });
  range.focus();
  fireEvent.change(range, { target: { value: "420" } });
  expect(range).toHaveValue("420");
  await user.keyboard("{Escape}");
  expect(trigger).toHaveFocus();
  expect(trigger).toHaveAttribute("aria-expanded", "false");
});

it("switches to one panel on narrow screens without destroying the chat", () => {
  const { rerender } = render(<Fixture />);
  const draft = screen.getByRole("textbox", { name: "Draft" });
  act(() => resize([{ contentRect: { width: 320 } }]));
  expect(screen.getByRole("button", { name: "Show results" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show results" }));
  expect(draft.isConnected).toBe(true);
  expect(draft.closest("[inert]")).not.toBeNull();
  rerender(<Fixture selectionKey="second" />);
  expect(screen.getByRole("button", { name: "Show results" })).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft);
});
