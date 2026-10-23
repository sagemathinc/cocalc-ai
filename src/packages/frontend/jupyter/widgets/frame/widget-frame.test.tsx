/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { act, fireEvent, render } from "@testing-library/react";
import { WIDGET_HOST_INIT, WIDGET_HOST_READY } from "./protocol";
import { WidgetFrame, WIDGET_FRAME_SANDBOX } from "./widget-frame";

jest.mock("@cocalc/frontend/customize/app-base-path", () => ({
  appBasePath: "/base",
}));

// Every frame is near the viewport.
class FakeIntersectionObserver {
  constructor(private callback: (entries: any[]) => void) {}
  observe() {
    this.callback([{ isIntersecting: true }]);
  }
  disconnect() {}
}
(globalThis as any).IntersectionObserver = FakeIntersectionObserver;
if ((globalThis as any).MessageChannel == null) {
  (globalThis as any).MessageChannel = require("worker_threads").MessageChannel;
}

function makeRelay() {
  const conn = { close: jest.fn(), setTheme: jest.fn() };
  return { conn, relay: { connect: jest.fn(() => conn) } as any };
}

function setup() {
  const { relay, conn } = makeRelay();
  const result = render(<WidgetFrame relay={relay} model_id="m1" />);
  const iframe = result.container.querySelector("iframe")!;
  const posted: any[] = [];
  jest
    .spyOn(iframe.contentWindow!, "postMessage")
    .mockImplementation((message: any, _origin: any, transfer?: any) => {
      posted.push({ message, transfer });
    });
  const nonce = new URL(iframe.src).hash.slice(1);
  const ready = (overrides: any = {}) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: WIDGET_HOST_READY, nonce },
          origin: "null",
          source: iframe.contentWindow,
          ...overrides,
        }),
      );
    });
  return { ...result, iframe, relay, conn, posted, nonce, ready };
}

describe("WidgetFrame", () => {
  it("is an opaque frame of the widget host with a fresh nonce and no permissions", () => {
    const { iframe, nonce } = setup();
    expect(iframe.getAttribute("sandbox")).toBe(WIDGET_FRAME_SANDBOX);
    expect(WIDGET_FRAME_SANDBOX.split(" ").sort()).toEqual([
      "allow-popups",
      "allow-scripts",
    ]);
    expect(iframe.hasAttribute("allow")).toBe(false);
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(new URL(iframe.src).pathname).toBe("/base/static/widget-host.html");
    expect(nonce).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("hands the relay's port to the host that said ready with its nonce", () => {
    const { ready, relay, posted } = setup();
    ready();
    expect(relay.connect).toHaveBeenCalledTimes(1);
    expect(relay.connect.mock.calls[0][1]).toBe("m1");
    expect(posted).toHaveLength(1);
    expect(posted[0].message.type).toBe(WIDGET_HOST_INIT);
    expect(posted[0].message.model_id).toBe("m1");
    expect(posted[0].transfer).toHaveLength(1);
  });

  it.each([
    ["a wrong nonce", { data: { type: WIDGET_HOST_READY, nonce: "x" } }],
    ["a non-opaque origin", { origin: "https://evil.example" }],
  ])("refuses a ready message with %s", (_name, overrides) => {
    const { ready, relay, container } = setup();
    ready(overrides);
    expect(relay.connect).not.toHaveBeenCalled();
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("ignores ready messages from other windows", () => {
    const { ready, relay, container } = setup();
    ready({ source: window });
    expect(relay.connect).not.toHaveBeenCalled();
    expect(container.querySelector("iframe")).not.toBeNull();
  });

  it("kills the frame if it says ready again", () => {
    const { ready, conn, container } = setup();
    ready();
    ready();
    expect(conn.close).toHaveBeenCalled();
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).toContain("restarted");
  });

  it("kills the frame if it loads another document after connecting", () => {
    const { ready, conn, iframe, container } = setup();
    ready();
    fireEvent.load(iframe); // the host's own load
    expect(container.querySelector("iframe")).not.toBeNull();
    fireEvent.load(iframe);
    expect(conn.close).toHaveBeenCalled();
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("kills the frame if it loads a second document before saying ready", () => {
    const { iframe, ready, relay, container } = setup();
    fireEvent.load(iframe);
    fireEvent.load(iframe);
    expect(container.querySelector("iframe")).toBeNull();
    ready();
    expect(relay.connect).not.toHaveBeenCalled();
  });

  it("closes the connection when unmounted", () => {
    const { ready, conn, unmount } = setup();
    ready();
    unmount();
    expect(conn.close).toHaveBeenCalled();
  });
});
