/** @jest-environment jsdom */

import { focusChatFrameInput } from "../actions";

describe("chat editor focus", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("focuses a Slate-backed chat frame by its frame id", () => {
    const frame = document.createElement("div");
    frame.id = "frame-frame-b";
    const editor = document.createElement("div");
    editor.setAttribute("role", "textbox");
    editor.setAttribute("contenteditable", "true");
    frame.appendChild(editor);
    document.body.appendChild(frame);

    expect(focusChatFrameInput("frame-b")).toBe(true);
    expect(document.activeElement).toBe(editor);
  });

  it("focuses a CodeMirror-backed chat frame by its frame id", () => {
    const frame = document.createElement("div");
    frame.id = "frame-frame-a";
    const cm = document.createElement("div");
    cm.className = "CodeMirror";
    const textarea = document.createElement("textarea");
    cm.appendChild(textarea);
    frame.appendChild(cm);
    document.body.appendChild(frame);

    expect(focusChatFrameInput("frame-a")).toBe(true);
    expect(document.activeElement).toBe(textarea);
  });

  it("prefers the editor over earlier mode-switch inputs", () => {
    const frame = document.createElement("div");
    frame.id = "frame-frame-a";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.value = "editor";
    frame.appendChild(radio);
    const cm = document.createElement("div");
    cm.className = "CodeMirror";
    const textarea = document.createElement("textarea");
    cm.appendChild(textarea);
    frame.appendChild(cm);
    document.body.appendChild(frame);

    expect(focusChatFrameInput("frame-a")).toBe(true);
    expect(document.activeElement).toBe(textarea);
  });

  it("returns false when the frame does not exist", () => {
    expect(focusChatFrameInput("missing")).toBe(false);
  });
});
