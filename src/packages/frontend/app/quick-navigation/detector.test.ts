/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

jest.mock("@cocalc/frontend/keyboard/boundary", () => ({
  getKeyboardBoundaryElement: () => null,
}));
import { createTapDetector } from "./detector";
import { navigationPreferences } from "./preferences";

describe("double Shift", () => {
  let now = 1000;
  beforeEach(() => {
    jest.spyOn(performance, "now").mockImplementation(() => now);
  });
  afterEach(() => jest.restoreAllMocks());
  const event = (type: string, key = "Shift", extra = {}) =>
    new KeyboardEvent(type, { key, ...extra });
  it("requires two complete taps within the configured interval", () => {
    const trigger = jest.fn();
    const detector = createTapDetector(400, trigger);
    detector.event(event("keydown"));
    detector.event(event("keyup"));
    now += 200;
    detector.event(event("keydown"));
    expect(trigger).not.toHaveBeenCalled();
    detector.event(event("keyup"));
    expect(trigger).toHaveBeenCalledTimes(1);
  });
  it.each(["a", "ArrowLeft", "Control"])("breaks the sequence on %s", (key) => {
    const trigger = jest.fn();
    const d = createTapDetector(400, trigger);
    d.event(event("keydown"));
    d.event(event("keyup"));
    d.event(event("keydown", key));
    d.event(event("keyup", key));
    now += 100;
    d.event(event("keydown"));
    d.event(event("keyup"));
    expect(trigger).not.toHaveBeenCalled();
  });
  it("ignores repeat, composition, simultaneous shifts and slow taps", () => {
    const trigger = jest.fn();
    const d = createTapDetector(400, trigger);
    d.event(event("keydown"));
    d.event(event("keydown", "Shift", { repeat: true }));
    d.event(event("keyup"));
    d.event(event("keydown", "Shift", { isComposing: true }));
    d.event(event("keyup"));
    d.event(event("keydown"));
    d.event(event("keydown"));
    d.event(event("keyup"));
    now += 1000;
    d.event(event("keydown"));
    d.event(event("keyup"));
    now += 1000;
    d.event(event("keydown"));
    d.event(event("keyup"));
    expect(trigger).not.toHaveBeenCalled();
  });
  it("enables by default and validates stored preferences", () => {
    expect(navigationPreferences(undefined)).toEqual({
      shortcut: "shift+shift",
      delay: 400,
    });
    expect(
      navigationPreferences(
        new Map([["quick_navigation_shortcut", "disabled"]]),
      ).shortcut,
    ).toBe("disabled");
    expect(
      navigationPreferences(new Map([["quick_navigation_delay", 5000]])).delay,
    ).toBe(1000);
  });
});

import { renderHook } from "@testing-library/react";
import { useNavigationShortcut } from "./detector";

describe("chord shortcuts", () => {
  const press = (init: KeyboardEventInit) => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  it.each([
    ["ctrl+shift+space", false, { key: " ", ctrlKey: true, shiftKey: true }],
    ["ctrl+shift+space", true, { key: " ", metaKey: true, shiftKey: true }],
    ["ctrl+k", false, { key: "k", ctrlKey: true }],
    ["ctrl+k", true, { key: "K", metaKey: true }],
  ] as const)("%s triggers (mac: %s)", (shortcut, mac, init) => {
    const trigger = jest.fn();
    const { unmount } = renderHook(() =>
      useNavigationShortcut(shortcut, 400, trigger, true, mac),
    );
    expect(press(init)).toBe(true);
    expect(trigger).toHaveBeenCalledTimes(1);
    unmount();
    expect(press(init)).toBe(false);
    expect(trigger).toHaveBeenCalledTimes(1);
  });
  it("ignores near misses: wrong modifier, Alt, Shift on Ctrl+K, autorepeat", () => {
    const trigger = jest.fn();
    const { unmount } = renderHook(() =>
      useNavigationShortcut("ctrl+k", 400, trigger, true, false),
    );
    press({ key: "k", metaKey: true });
    press({ key: "k", ctrlKey: true, altKey: true });
    press({ key: "k", ctrlKey: true, shiftKey: true });
    press({ key: "k", ctrlKey: true, repeat: true });
    press({ key: " ", ctrlKey: true, shiftKey: true });
    expect(trigger).not.toHaveBeenCalled();
    unmount();
    const { unmount: unmount2 } = renderHook(() =>
      useNavigationShortcut("ctrl+shift+space", 400, trigger, true, false),
    );
    press({ key: " ", ctrlKey: true });
    press({ key: " ", altKey: true, shiftKey: true });
    expect(trigger).not.toHaveBeenCalled();
    unmount2();
  });
});
