/** @jest-environment jsdom */

import {
  captureChatViewportAnchor,
  clearChatViewportAnchorCacheForTests,
  loadChatViewportAnchor,
  resolveChatViewportAnchorIndex,
  restoreChatViewportAnchorOffset,
  saveChatViewportAnchor,
  type ChatViewportAnchor,
} from "../chat-scroll-anchor";

function rect(top: number, bottom: number): DOMRect {
  return {
    bottom,
    height: bottom - top,
    left: 0,
    right: 100,
    top,
    width: 100,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function mockRect(element: Element, top: number, bottom: number): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => rect(top, bottom),
  });
}

function makeScroller() {
  const scroller = document.createElement("div");
  Object.defineProperty(scroller, "clientHeight", {
    configurable: true,
    value: 300,
  });
  Object.defineProperty(scroller, "scrollHeight", {
    configurable: true,
    value: 1000,
  });
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    writable: true,
    value: 100,
  });
  mockRect(scroller, 100, 400);
  return scroller;
}

describe("chat scroll anchors", () => {
  beforeEach(() => {
    clearChatViewportAnchorCacheForTests();
    document.body.innerHTML = "";
  });

  it("captures the first visible message and its viewport offset", () => {
    const scroller = makeScroller();
    const hidden = document.createElement("div");
    hidden.setAttribute("data-item-index", "0");
    mockRect(hidden, 20, 90);
    const visible = document.createElement("div");
    visible.setAttribute("data-item-index", "1");
    mockRect(visible, 130, 250);
    scroller.append(hidden, visible);

    expect(
      captureChatViewportAnchor({
        now: 123,
        scroller,
        sortedDates: ["1000", "2000"],
      }),
    ).toEqual({
      atBottom: false,
      date: "2000",
      offsetPx: 30,
      savedAt: 123,
    });
  });

  it("captures bottom anchoring instead of a message offset near the bottom", () => {
    const scroller = makeScroller();
    scroller.scrollTop = 690;

    expect(
      captureChatViewportAnchor({
        now: 456,
        scroller,
        sortedDates: ["1000", "2000"],
      }),
    ).toEqual({
      atBottom: true,
      date: "2000",
      offsetPx: 0,
      savedAt: 456,
    });
  });

  it("resolves removed anchors to the next message by date", () => {
    const anchor: ChatViewportAnchor = {
      atBottom: false,
      date: "2500",
      offsetPx: 20,
      savedAt: 1,
    };

    expect(resolveChatViewportAnchorIndex(anchor, ["1000", "3000"])).toBe(1);
    expect(resolveChatViewportAnchorIndex(anchor, ["1000", "2000"])).toBe(1);
  });

  it("adjusts scrollTop to restore the saved message offset", () => {
    const scroller = makeScroller();
    const visible = document.createElement("div");
    visible.setAttribute("data-item-index", "1");
    mockRect(visible, 180, 280);
    scroller.append(visible);

    restoreChatViewportAnchorOffset({
      anchor: {
        atBottom: false,
        date: "2000",
        offsetPx: 30,
        savedAt: 1,
      },
      scroller,
      sortedDates: ["1000", "2000"],
    });

    expect(scroller.scrollTop).toBe(150);
  });

  it("persists anchors by cache id", () => {
    saveChatViewportAnchor("chat-1", {
      atBottom: false,
      date: "2000",
      offsetPx: 12,
      savedAt: 99,
    });

    expect(loadChatViewportAnchor("chat-1")).toEqual({
      atBottom: false,
      date: "2000",
      offsetPx: 12,
      savedAt: 99,
    });
  });
});
