/** @jest-environment jsdom */

import { render } from "@testing-library/react";
import KeyboardShortcuts from "./keyboard";

const mockCommand = jest.fn();
const mockSetActiveKeyHandler = jest.fn();
const mockEraseActiveKeyHandler = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: (name: string) => {
      if (name === "page") {
        return {
          set_active_key_handler: mockSetActiveKeyHandler,
          erase_active_key_handler: mockEraseActiveKeyHandler,
        };
      }
      if (name === "messages") {
        return { command: mockCommand };
      }
      return undefined;
    },
  },
}));

describe("messages keyboard shortcuts", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    mockCommand.mockClear();
    mockSetActiveKeyHandler.mockClear();
    mockEraseActiveKeyHandler.mockClear();
  });

  function getRegisteredHandler() {
    const handler = mockSetActiveKeyHandler.mock.calls[0]?.[0];
    expect(typeof handler).toBe("function");
    return handler;
  }

  it("registers a page-level handler", () => {
    render(<KeyboardShortcuts />);
    getRegisteredHandler();
  });

  it("suppresses shortcuts inside a keyboard boundary", () => {
    render(<KeyboardShortcuts />);
    const handler = getRegisteredHandler();
    const boundary = document.createElement("div");
    boundary.setAttribute("data-cocalc-keyboard-boundary", "dock");
    const target = document.createElement("div");
    boundary.appendChild(target);
    document.body.appendChild(boundary);

    handler({ key: "j", target });

    expect(mockCommand).not.toHaveBeenCalled();
  });

  it("dispatches message commands when no boundary owns the keyboard", () => {
    render(<KeyboardShortcuts />);
    const handler = getRegisteredHandler();

    handler({ key: "j", target: document.body });

    expect(mockCommand).toHaveBeenCalledWith("down");
  });
});
