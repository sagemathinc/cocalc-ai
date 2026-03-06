/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";

const mockRunShortcut = jest.fn();

jest.mock("./commands", () => ({
  commands: () => ({
    move_down: {
      k: [{ which: 74, mode: "escape" }],
      f: mockRunShortcut,
    },
  }),
}));

const { create_key_handler } = require("./keyboard");

describe("Jupyter keyboard boundary suppression", () => {
  beforeEach(() => {
    mockRunShortcut.mockClear();
  });

  it("does not run command-mode shortcuts inside a keyboard boundary", () => {
    render(
      <div data-cocalc-keyboard-boundary="dock">
        <button data-testid="inside">inside</button>
      </div>,
    );

    const handler = create_key_handler(
      {
        store: {
          get: (key: string) => (key === "complete" ? null : undefined),
        },
      },
      {
        store: {
          get: (key: string) => (key === "mode" ? "escape" : undefined),
        },
      },
      {},
    );

    const button = screen.getByTestId("inside");
    const event = new KeyboardEvent("keydown", { bubbles: true });
    Object.defineProperty(event, "target", { value: button });
    Object.defineProperty(event, "which", { value: 74 });

    handler(event);

    expect(mockRunShortcut).not.toHaveBeenCalled();
  });

  it("still runs command-mode shortcuts for a plain notebook div target", () => {
    render(<div data-testid="plain" tabIndex={0} />);

    const handler = create_key_handler(
      {
        store: {
          get: (key: string) => (key === "complete" ? null : undefined),
        },
      },
      {
        store: {
          get: (key: string) => (key === "mode" ? "escape" : undefined),
        },
      },
      {},
    );

    const div = screen.getByTestId("plain");
    div.focus();
    const event = new KeyboardEvent("keydown", { bubbles: true });
    Object.defineProperty(event, "target", { value: div });
    Object.defineProperty(event, "which", { value: 74 });

    handler(event);

    expect(mockRunShortcut).toHaveBeenCalledTimes(1);
  });
});
