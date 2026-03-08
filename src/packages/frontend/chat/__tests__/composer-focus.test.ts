/** @jest-environment jsdom */

import {
  findChatComposerFocusTarget,
  refocusChatComposerInput,
} from "../composer";

describe("chat composer refocus", () => {
  it("prefers the registered chat input control when available", () => {
    const root = document.createElement("div");
    const input = document.createElement("input");
    input.focus = jest.fn();
    root.appendChild(input);

    const focus = jest.fn(() => true);

    expect(refocusChatComposerInput(root, { focus })).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(input.focus).not.toHaveBeenCalled();
  });

  it("prefers the slate editor over generic inputs when falling back to DOM focus", () => {
    const root = document.createElement("div");
    const modeToggle = document.createElement("input");
    modeToggle.type = "radio";
    const editor = document.createElement("div");
    editor.setAttribute("data-slate-editor", "true");
    editor.setAttribute("contenteditable", "true");
    root.append(modeToggle, editor);

    expect(findChatComposerFocusTarget(root)).toBe(editor);
    expect(refocusChatComposerInput(root, null)).toBe(true);
  });
});
