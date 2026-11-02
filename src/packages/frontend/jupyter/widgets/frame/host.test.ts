/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

jest.mock("@jupyter-widgets/controls/css/widgets.css", () => ({}));
jest.mock("./math", () => ({
  typesetMath: jest.fn(),
  typesetWidgetMath: jest.fn(),
}));
jest.mock("./outputs", () => ({ renderOutput: jest.fn() }));
const created: any[] = [];
jest.mock("./widget-manager", () => ({
  WidgetManager: class {
    manager = { render: jest.fn(async () => {}) };
    constructor(opts: any) {
      created.push(this);
      (this as any).opts = opts;
    }
  },
}));

import { init, isIsolated } from "./host";

describe("isIsolated", () => {
  it("holds only in an opaque origin inside a parent", () => {
    const parent = {} as any;
    expect(isIsolated({ origin: "null", parent } as any)).toBe(true);
    const top: any = { origin: "null" };
    top.parent = top;
    expect(isIsolated(top)).toBe(false);
    expect(
      isIsolated({ origin: "https://cocalc.example", parent } as any),
    ).toBe(false);
  });
});

describe("init", () => {
  it("does nothing outside an opaque origin (e.g. opened as a page)", () => {
    document.body.innerHTML = '<div id="cocalc-widget"></div>';
    const postMessage = jest.spyOn(window.parent, "postMessage");
    init();
    expect(document.body.textContent).toContain(
      "Widgets render only inside a notebook",
    );
    expect(postMessage).not.toHaveBeenCalled();
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "cocalc-widget-host-init", model_id: "m1" },
        source: window.parent,
      }),
    );
    expect(created).toHaveLength(0);
  });
});
