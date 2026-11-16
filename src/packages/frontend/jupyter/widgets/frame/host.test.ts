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

import { applyTheme, init, isIsolated } from "./host";

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

describe("applyTheme", () => {
  beforeAll(() => {
    // jsdom has no CSS.supports
    const css = ((globalThis as any).CSS ??= {});
    if (typeof css.supports !== "function") css.supports = () => true;
  });

  it("maps the widget library's light colors onto the app palette", () => {
    const style = document.documentElement.style;
    applyTheme({
      text: "rgb(230, 230, 230)",
      surface: "rgb(20, 20, 20)",
      inset: "rgb(35, 35, 35)",
      border: "rgb(90, 90, 90)",
      colorScheme: "dark",
    } as any);
    // labels and slider readouts (--jp-widgets-readout-color follows this)
    expect(style.getPropertyValue("--jp-content-font-color1")).toBe(
      "rgb(230, 230, 230)",
    );
    expect(style.getPropertyValue("--jp-ui-font-color1")).toBe(
      "rgb(230, 230, 230)",
    );
    // input backgrounds and slider handles
    expect(style.getPropertyValue("--jp-layout-color1")).toBe(
      "rgb(20, 20, 20)",
    );
    expect(style.getPropertyValue("--jp-border-color1")).toBe(
      "rgb(90, 90, 90)",
    );
    // tag input, selected tab and open accordion header text
    expect(style.getPropertyValue("--jp-ui-font-color0")).toBe(
      "rgb(230, 230, 230)",
    );
    // inactive tabs and closed accordion headers: dimmed text
    expect(style.getPropertyValue("--jp-ui-font-color2")).toBe(
      "color-mix(in srgb, rgb(230, 230, 230) 70%, transparent)",
    );
    expect(style.getPropertyValue("--shell-text")).toBe("rgb(230, 230, 230)");
    expect(style.colorScheme).toBe("dark");
  });

  it("leaves a color it can't validate unset", () => {
    const style = document.documentElement.style;
    style.removeProperty("--jp-layout-color2");
    const supports = (globalThis as any).CSS.supports;
    (globalThis as any).CSS.supports = () => false;
    try {
      applyTheme({ inset: "url(x)" } as any);
    } finally {
      (globalThis as any).CSS.supports = supports;
    }
    expect(style.getPropertyValue("--jp-layout-color2")).toBe("");
  });
});
