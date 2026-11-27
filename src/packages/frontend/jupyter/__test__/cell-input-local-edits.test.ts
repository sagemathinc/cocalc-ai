/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { isEditingKeyEvent, watchLocalEdits } from "../cell-input-local-edits";

describe("local edit detection", () => {
  it.each([
    ["a", {}, true],
    [" ", {}, true],
    ["Backspace", {}, true],
    ["Delete", {}, true],
    ["Enter", {}, true],
    ["z", { ctrlKey: true }, true],
    ["v", { metaKey: true }, true],
    ["c", { ctrlKey: true }, false],
    ["ArrowDown", {}, false],
    ["Escape", {}, false],
    ["Shift", {}, false],
    ["PageDown", {}, false],
  ])("key %s %j edits: %s", (key, mods, edits) => {
    expect(isEditingKeyEvent({ key, ...mods })).toBe(edits);
  });

  it("watches input events within the element, and stops on cleanup", () => {
    const element = document.createElement("div");
    const child = document.createElement("div");
    element.appendChild(child);
    const onEdit = jest.fn();
    const stop = watchLocalEdits(element, onEdit);
    child.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    expect(onEdit).not.toHaveBeenCalled();
    child.dispatchEvent(new Event("paste", { bubbles: true }));
    child.dispatchEvent(new KeyboardEvent("keydown", { key: "q" }));
    expect(onEdit).toHaveBeenCalledTimes(2);
    stop();
    child.dispatchEvent(new KeyboardEvent("keydown", { key: "q" }));
    expect(onEdit).toHaveBeenCalledTimes(2);
  });
});
