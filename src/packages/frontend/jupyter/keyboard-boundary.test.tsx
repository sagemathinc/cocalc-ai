/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";

const mockRunShortcut = jest.fn();
const mockHandoffNavigation = jest.fn();
const mockMatchNavigationCommand = jest.fn();

jest.mock("./commands", () => ({
  commands: () => ({
    move_down: {
      k: [{ which: 74, mode: "escape" }],
      f: mockRunShortcut,
    },
  }),
}));

jest.mock("@cocalc/frontend/project/page/keyboard-navigation", () => ({
  handoffProjectNavigationFromLocalOwner: (...args: any[]) =>
    mockHandoffNavigation(...args),
  matchProjectNavigationCommand: (...args: any[]) =>
    mockMatchNavigationCommand(...args),
}));

const { create_key_handler } = require("./keyboard");

describe("Jupyter keyboard boundary suppression", () => {
  beforeEach(() => {
    mockRunShortcut.mockClear();
    mockHandoffNavigation.mockClear();
    mockMatchNavigationCommand.mockReset();
    mockMatchNavigationCommand.mockReturnValue(undefined);
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

  it("hands reserved navigation keys to project navigation instead of notebook shortcuts", () => {
    mockMatchNavigationCommand.mockReturnValue("focusNextFrame");
    const preventDefault = jest.fn();
    const stopPropagation = jest.fn();
    const editorActions = {
      _get_project_actions: () => ({ focus_file_tab_strip: jest.fn() }),
      project_id: "project-1",
    };

    const handler = create_key_handler(
      {
        store: {
          get: () => null,
        },
      },
      {
        frame_id: "frame-a",
        store: {
          get: () => "escape",
        },
      },
      editorActions,
    );

    const result = handler({
      preventDefault,
      stopPropagation,
      target: document.body,
    });

    expect(result).toBe(false);
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
    expect(mockRunShortcut).not.toHaveBeenCalled();
    expect(mockHandoffNavigation).toHaveBeenCalledWith(
      "focusNextFrame",
      "project-1",
      expect.objectContaining({
        currentFrameId: "frame-a",
        editorActions,
      }),
    );
  });
});
