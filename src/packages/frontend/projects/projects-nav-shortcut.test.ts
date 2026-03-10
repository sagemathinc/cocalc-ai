/** @jest-environment jsdom */

import { shouldOpenProjectsNavShortcut } from "./projects-nav-shortcut";

describe("projects nav shortcut", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  function keydownEvent(target: EventTarget): KeyboardEvent {
    return {
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
      key: "P",
      target,
      composedPath: () => [target, document.body, document, window],
    } as unknown as KeyboardEvent;
  }

  it("opens from shell-level focus", () => {
    expect(shouldOpenProjectsNavShortcut(keydownEvent(document.body))).toBe(
      true,
    );
  });

  it("does not open inside a keyboard boundary", () => {
    const boundary = document.createElement("div");
    boundary.setAttribute("data-cocalc-keyboard-boundary", "dock");
    const inside = document.createElement("div");
    boundary.appendChild(inside);
    document.body.appendChild(boundary);

    expect(shouldOpenProjectsNavShortcut(keydownEvent(inside))).toBe(false);
  });

  it("does not open from editable targets", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);

    expect(shouldOpenProjectsNavShortcut(keydownEvent(input))).toBe(false);
  });
});
