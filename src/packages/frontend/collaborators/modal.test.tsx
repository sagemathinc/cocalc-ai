import { useState } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { CollaboratorsModal } from "./modal";

test("scopes the real modal portal while preserving caller classes and content", async () => {
  const getComputedStyle = window.getComputedStyle;
  const spy = jest
    .spyOn(window, "getComputedStyle")
    .mockImplementation((element) => getComputedStyle(element));
  try {
    render(
      <CollaboratorsModal open title="Scoped dialog" rootClassName="caller">
        <input aria-label="Dialog input" />
      </CollaboratorsModal>,
    );
    const dialog = screen.getByRole("dialog", { name: "Scoped dialog" });
    expect(dialog.closest(".collaborators-modal.caller")).not.toBeNull();
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Dialog input" }),
      ).toBeVisible(),
    );
  } finally {
    spy.mockRestore();
  }
});

test("reduced motion disables transitions and Escape restores trigger focus", async () => {
  const original = window.matchMedia;
  const listeners = new Set<() => void>();
  let matches = true;
  window.matchMedia = jest.fn((media) => ({
    media,
    get matches() {
      return matches;
    },
    onchange: null,
    addEventListener: (_type: string, listener: () => void) =>
      listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) =>
      listeners.delete(listener),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })) as typeof window.matchMedia;
  const getComputedStyle = window.getComputedStyle;
  const spy = jest
    .spyOn(window, "getComputedStyle")
    .mockImplementation((element) => getComputedStyle(element));
  const afterClose = jest.fn();
  function Example() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open sharing</button>
        <CollaboratorsModal
          open={open}
          title="Sharing"
          onCancel={() => setOpen(false)}
          afterClose={afterClose}
          transitionName="custom-motion"
          maskTransitionName="custom-mask-motion"
        >
          <input aria-label="Search discussions" />
        </CollaboratorsModal>
      </>
    );
  }
  let unmount: (() => void) | undefined;
  try {
    ({ unmount } = render(<Example />));
    const trigger = screen.getByRole("button", { name: "Open sharing" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Sharing" });
    expect(dialog.className).not.toMatch(/custom-motion/);
    expect(document.querySelector(".ant-modal-mask")?.className).not.toMatch(
      /custom-mask-motion/,
    );
    const input = screen.getByRole("textbox", { name: "Search discussions" });
    input.focus();
    fireEvent.keyDown(input, { key: "Escape", code: "Escape", keyCode: 27 });
    await waitFor(() => expect(afterClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog", { name: "Sharing" })).toBeNull();
    expect(trigger).toHaveFocus();
    act(() => {
      matches = false;
      for (const listener of listeners) listener();
    });
    expect(window.matchMedia).toHaveBeenCalledWith(
      "(prefers-reduced-motion: reduce)",
    );
  } finally {
    unmount?.();
    window.matchMedia = original;
    spy.mockRestore();
  }
  expect(listeners.size).toBe(0);
});
