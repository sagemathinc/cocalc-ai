/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";

const mockEraseActiveKeyHandler = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: (name: string) =>
      name === "page"
        ? { erase_active_key_handler: mockEraseActiveKeyHandler }
        : undefined,
  },
}));

const {
  eventTargetsElement,
  KEYBOARD_BOUNDARY_ATTRIBUTE,
  KeyboardBoundary,
  isInsideKeyboardBoundary,
  shouldSuppressGlobalShortcuts,
} = require("../boundary");

describe("keyboard boundary helpers", () => {
  beforeEach(() => {
    mockEraseActiveKeyHandler.mockClear();
  });

  it("detects when an element is inside a keyboard boundary", () => {
    render(
      <div {...{ [KEYBOARD_BOUNDARY_ATTRIBUTE]: "overlay" }}>
        <button data-testid="inside">inside</button>
      </div>,
    );

    expect(isInsideKeyboardBoundary(screen.getByTestId("inside"))).toBe(true);
  });

  it("suppresses global shortcuts for boundary events", () => {
    render(
      <div {...{ [KEYBOARD_BOUNDARY_ATTRIBUTE]: "dock" }}>
        <button data-testid="inside">inside</button>
      </div>,
    );

    const button = screen.getByTestId("inside");
    const event = new KeyboardEvent("keydown", { bubbles: true });
    Object.defineProperty(event, "target", { value: button });

    expect(shouldSuppressGlobalShortcuts(event)).toBe(true);
  });

  it("detects when an event targets a given element through the DOM path", () => {
    render(
      <div data-testid="container">
        <button data-testid="inside">inside</button>
      </div>,
    );

    const container = screen.getByTestId("container");
    const button = screen.getByTestId("inside");
    const event = new MouseEvent("click", { bubbles: true });
    Object.defineProperty(event, "target", { value: button });

    expect(eventTargetsElement(event, container)).toBe(true);
  });

  it("suppresses global shortcuts for editable targets even without a boundary", () => {
    render(<textarea data-testid="editor" />);
    const textarea = screen.getByTestId("editor");
    textarea.focus();

    const event = new KeyboardEvent("keydown", { bubbles: true });
    Object.defineProperty(event, "target", { value: textarea });

    expect(shouldSuppressGlobalShortcuts(event)).toBe(true);
  });

  it("does not suppress global shortcuts for a plain focused div", () => {
    render(<div data-testid="plain" tabIndex={0} />);
    const div = screen.getByTestId("plain");
    div.focus();

    const event = new KeyboardEvent("keydown", { bubbles: true });
    Object.defineProperty(event, "target", { value: div });

    expect(shouldSuppressGlobalShortcuts(event)).toBe(false);
  });
});

describe("KeyboardBoundary component", () => {
  beforeEach(() => {
    mockEraseActiveKeyHandler.mockClear();
  });

  it("marks its subtree and clears the page handler on focus", () => {
    render(
      <KeyboardBoundary boundary="flyout">
        <button data-testid="focus-target">focus</button>
      </KeyboardBoundary>,
    );

    const button = screen.getByTestId("focus-target");
    fireEvent.focus(button);

    expect(button.closest(`[${KEYBOARD_BOUNDARY_ATTRIBUTE}]`)).toBeTruthy();
    expect(mockEraseActiveKeyHandler).toHaveBeenCalledTimes(1);
  });

  it("stops window click bubbling when configured", () => {
    const onWindowClick = jest.fn();
    window.addEventListener("click", onWindowClick);

    render(
      <KeyboardBoundary boundary="dock" stopClickPropagation>
        <button data-testid="click-target">click</button>
      </KeyboardBoundary>,
    );

    fireEvent.click(screen.getByTestId("click-target"));

    expect(onWindowClick).not.toHaveBeenCalled();
    window.removeEventListener("click", onWindowClick);
  });
});
