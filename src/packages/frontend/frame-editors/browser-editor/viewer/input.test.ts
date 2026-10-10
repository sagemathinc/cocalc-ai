/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  isAccel,
  isApple,
  keyMessage,
  modifiers,
  nextZoom,
  zoomShortcut,
} from "./input";

const key = (k: string, extra: Partial<KeyboardEvent> = {}) => ({
  key: k,
  code: extra.code ?? "",
  keyCode: extra.keyCode ?? 0,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...extra,
});

describe("the human's keys become the browser's", () => {
  it("recognizes Apple devices", () => {
    expect(isApple("MacIntel")).toBe(true);
    expect(isApple("iPad")).toBe(true);
    expect(isApple("Linux x86_64")).toBe(false);
    expect(isApple("Win32")).toBe(false);
  });

  it("maps Cmd to Ctrl on Apple devices, since the browser runs on Linux", () => {
    expect(modifiers(key("a", { metaKey: true }), true)).toBe(2);
    expect(modifiers(key("a", { metaKey: true }), false)).toBe(4);
    expect(modifiers(key("a", { ctrlKey: true, shiftKey: true }), false)).toBe(
      10,
    );
    expect(modifiers(key("a", { altKey: true }), false)).toBe(1);
    expect(isAccel(key("c", { metaKey: true }), true)).toBe(true);
    expect(isAccel(key("c", { ctrlKey: true }), true)).toBe(false);
    expect(isAccel(key("c", { ctrlKey: true }), false)).toBe(true);
    expect(isAccel(key("c", { ctrlKey: true, altKey: true }), false)).toBe(
      false,
    );
  });

  it("sends characters as text, with the key codes CDP wants", () => {
    expect(keyMessage("keyDown", key("a", { code: "KeyA" }), false)).toEqual({
      type: "key",
      event: "keyDown",
      key: "a",
      code: "KeyA",
      text: "a",
      keyCode: 65,
      modifiers: 0,
    });
    // "(" has char code 40, which is ArrowDown's key code: never use it.
    const paren = keyMessage("keyDown", key("(", { shiftKey: true }), false);
    expect(paren.text).toBe("(");
    expect(paren.keyCode).toBe(0);
    expect(keyMessage("keyDown", key("Enter"), false)).toMatchObject({
      event: "keyDown",
      text: "\r",
      keyCode: 13,
    });
    expect(keyMessage("keyDown", key("ArrowDown"), false)).toMatchObject({
      event: "rawKeyDown",
      text: undefined,
      keyCode: 40,
    });
    expect(keyMessage("keyUp", key("a"), false)).toMatchObject({
      event: "keyUp",
      text: undefined,
    });
    // A shortcut is not text.
    expect(
      keyMessage("keyDown", key("a", { ctrlKey: true }), false),
    ).toMatchObject({ event: "rawKeyDown", text: undefined, modifiers: 2 });
  });

  it("zooms with the browser's shortcuts, in its steps", () => {
    expect(zoomShortcut(key("=", { ctrlKey: true }), false)).toBe(1);
    expect(zoomShortcut(key("+", { ctrlKey: true }), false)).toBe(1);
    expect(zoomShortcut(key("-", { metaKey: true }), true)).toBe(-1);
    expect(zoomShortcut(key("0", { ctrlKey: true }), false)).toBe(0);
    expect(zoomShortcut(key("0"), false)).toBeUndefined();
    expect(zoomShortcut(key("c", { ctrlKey: true }), false)).toBeUndefined();
    expect(nextZoom(1, 1)).toBe(1.1);
    expect(nextZoom(1, -1)).toBe(0.9);
    expect(nextZoom(1.3, 1)).toBe(1.5);
    expect(nextZoom(5, 1)).toBe(5);
    expect(nextZoom(0.5, -1)).toBe(0.5);
    expect(nextZoom(2.5, 0)).toBe(1);
  });
});
