/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import {
  chatPanelOwnsThreadSearchShortcut,
  shouldOpenThreadSearchShortcut,
} from "../chatroom-thread-panel-shortcuts";

function defineEventTarget(event: KeyboardEvent, target: EventTarget) {
  Object.defineProperty(event, "target", {
    configurable: true,
    value: target,
  });
}

describe("chatroom thread panel shortcuts", () => {
  it("does not open thread search when Ctrl/Cmd+F targets a CodeMirror surface", () => {
    render(
      <div className="CodeMirror">
        <div data-testid="cm-target" tabIndex={0}>
          editor
        </div>
      </div>,
    );

    const target = screen.getByTestId("cm-target");
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      ctrlKey: true,
      key: "f",
    });
    defineEventTarget(event, target);

    expect(shouldOpenThreadSearchShortcut(event, false)).toBe(false);
  });

  it("does not open thread search when another keyboard boundary owns focus", () => {
    render(
      <div data-cocalc-keyboard-boundary="timetravel">
        <button data-testid="inside-boundary" type="button">
          editor
        </button>
      </div>,
    );

    const target = screen.getByTestId("inside-boundary");
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      metaKey: true,
      key: "f",
    });
    defineEventTarget(event, target);

    expect(shouldOpenThreadSearchShortcut(event, false)).toBe(false);
  });

  it("opens thread search for plain Ctrl/Cmd+F when chat owns focus", () => {
    render(
      <div>
        <div data-testid="plain" tabIndex={0}>
          chat
        </div>
      </div>,
    );

    const target = screen.getByTestId("plain");
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      ctrlKey: true,
      key: "f",
    });
    defineEventTarget(event, target);

    expect(shouldOpenThreadSearchShortcut(event, false)).toBe(true);
  });

  it("does not open thread search when the chat panel is not visible", () => {
    render(
      <div>
        <div data-testid="plain" tabIndex={0}>
          chat
        </div>
      </div>,
    );

    const target = screen.getByTestId("plain");
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      ctrlKey: true,
      key: "f",
    });
    defineEventTarget(event, target);

    expect(shouldOpenThreadSearchShortcut(event, false, false)).toBe(false);
  });

  it("only lets the owning chat panel react to the shortcut", () => {
    render(
      <div>
        <div data-testid="chat-a">
          <button data-testid="button-a" type="button">
            a
          </button>
        </div>
        <div data-testid="chat-b">
          <button data-testid="button-b" type="button">
            b
          </button>
        </div>
      </div>,
    );

    const chatA = screen.getByTestId("chat-a");
    const chatB = screen.getByTestId("chat-b");
    const buttonA = screen.getByTestId("button-a");
    buttonA.focus();
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      ctrlKey: true,
      key: "f",
    });
    defineEventTarget(event, buttonA);

    expect(chatPanelOwnsThreadSearchShortcut(chatA, event)).toBe(true);
    expect(chatPanelOwnsThreadSearchShortcut(chatB, event)).toBe(false);
  });
});
