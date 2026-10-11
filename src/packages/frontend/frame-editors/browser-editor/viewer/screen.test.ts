/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  SharedBrowserState,
  ViewerMessage,
} from "@cocalc/util/shared-browser-protocol";

import { BrowserScreen, type ScreenHost } from "./screen";

// What jsdom lacks.
beforeAll(() => {
  (global as any).ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  window.matchMedia = (() => ({
    addEventListener() {},
    removeEventListener() {},
  })) as any;
  HTMLCanvasElement.prototype.getContext = (() => ({
    fillRect() {},
    drawImage() {},
  })) as any;
});

function setup(driving = true) {
  const stage = document.createElement("div");
  const canvas = document.createElement("canvas");
  const keys = document.createElement("textarea");
  stage.append(canvas, keys);
  document.body.append(stage);
  const rect = { left: 0, top: 0, width: 800, height: 600, x: 0, y: 0 };
  for (const el of [stage, canvas])
    el.getBoundingClientRect = () =>
      ({ ...rect, right: 800, bottom: 600 }) as DOMRect;
  const sent: ViewerMessage[] = [];
  const calls = { notDriving: 0, zoom: [] as number[] };
  const state = {
    driver: driving ? "human" : "agent",
    viewport: { width: 400, height: 300 },
    select: null,
  } as unknown as SharedBrowserState;
  const host: ScreenHost = {
    send: (msg) => sent.push(msg),
    state: () => state,
    human: () => driving,
    quality: () => "balanced",
    notDriving: () => calls.notDriving++,
    zoomStep: (d) => calls.zoom.push(d),
    pointer: () => {},
  };
  const screen = new BrowserScreen(stage, canvas, keys, host);
  return { screen, stage, canvas, keys, sent, calls };
}

afterEach(() => {
  document.body.innerHTML = "";
});

const press = (target: EventTarget, init: KeyboardEventInit) => {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
};

function clipboardEvent(type: string, text = "") {
  const data: Record<string, string> = { text, "text/plain": text };
  const event = new Event(type, { bubbles: true, cancelable: true }) as any;
  event.clipboardData = {
    getData: (kind: string) => data[kind] ?? "",
    setData: (kind: string, value: string) => (data[kind] = value),
  };
  return { event, data };
}

describe("the browser's screen", () => {
  it("sends the human's keys to the browser, not to CoCalc's shortcuts", () => {
    const { screen, keys, sent } = setup();
    const seenByCoCalc: string[] = [];
    const listener = (e: KeyboardEvent) => seenByCoCalc.push(e.key);
    document.addEventListener("keydown", listener);
    try {
      const event = press(keys, { key: "a", code: "KeyA" });
      expect(event.defaultPrevented).toBe(true);
      expect(sent).toEqual([
        expect.objectContaining({ type: "key", event: "keyDown", text: "a" }),
      ]);
      expect(seenByCoCalc).toEqual([]);
    } finally {
      document.removeEventListener("keydown", listener);
      screen.destroy();
    }
  });

  it("says why when the human types without driving, and zooms anyway", () => {
    const { screen, keys, sent, calls } = setup(false);
    press(keys, { key: "a" });
    expect(sent).toEqual([]);
    expect(calls.notDriving).toBe(1);
    press(keys, { key: "=", ctrlKey: true });
    expect(calls.zoom).toEqual([1]);
    screen.destroy();
  });

  it("copies the page's selection, driving or not, and pastes as text", () => {
    const { screen, keys, sent } = setup(true);
    screen.setSelection("selected words");
    keys.focus();
    expect(keys.value).toBe("selected words");
    // Ctrl+C reaches the page (its own copy handlers) and is not prevented,
    // so the system copy happens.
    const ctrlC = press(keys, { key: "c", ctrlKey: true });
    expect(ctrlC.defaultPrevented).toBe(false);
    expect(sent.at(-1)).toMatchObject({ type: "key", key: "c", modifiers: 2 });
    const copy = clipboardEvent("copy");
    keys.dispatchEvent(copy.event);
    expect(copy.data["text/plain"]).toBe("selected words");
    // Paste: the clipboard's text, typed into the page.
    const paste = clipboardEvent("paste", "from my clipboard");
    keys.dispatchEvent(paste.event);
    expect(sent.at(-1)).toEqual({ type: "text", text: "from my clipboard" });
    screen.destroy();
  });

  it("puts clicks where they are on the page, scaled to its viewport", () => {
    const { screen, canvas, sent } = setup(true);
    canvas.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        clientX: 200,
        clientY: 100,
        button: 0,
        detail: 1,
      }),
    );
    // The viewport is 400x300 shown in 800x600: half.
    expect(sent.find((m) => m.type === "mouse")).toMatchObject({
      type: "mouse",
      event: "mousePressed",
      x: 100,
      y: 50,
      button: "left",
      clickCount: 1,
    });
    screen.destroy();
  });

  it("stops listening when destroyed", () => {
    const { screen, keys, sent } = setup(true);
    screen.destroy();
    keys.focus();
    const paste = clipboardEvent("paste", "late");
    keys.dispatchEvent(paste.event);
    press(keys, { key: "a" });
    expect(sent.filter((m) => m.type === "text" || m.type === "key")).toEqual(
      [],
    );
  });
});
