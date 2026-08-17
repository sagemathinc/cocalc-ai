/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  addExplorerKeyboardListeners,
  pageHasFocusedElement,
} from "./keyboard";

describe("Explorer keyboard handling", () => {
  test("detects focus without requiring the legacy jQuery global", () => {
    delete (globalThis as { $?: unknown }).$;
    document.body.innerHTML = '<input aria-label="File search" />';
    const input = document.querySelector("input");

    expect(pageHasFocusedElement()).toBe(false);
    input?.focus();
    expect(pageHasFocusedElement()).toBe(true);
    input?.blur();
    expect(pageHasFocusedElement()).toBe(false);
  });

  test("installs and removes native window listeners", () => {
    const handleKeyDown = jest.fn();
    const handleKeyUp = jest.fn();
    const remove = addExplorerKeyboardListeners({
      handleKeyDown,
      handleKeyUp,
    });

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift" }));
    expect(handleKeyDown).toHaveBeenCalledTimes(1);
    expect(handleKeyUp).toHaveBeenCalledTimes(1);

    remove();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift" }));
    expect(handleKeyDown).toHaveBeenCalledTimes(1);
    expect(handleKeyUp).toHaveBeenCalledTimes(1);
  });
});
