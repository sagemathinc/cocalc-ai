/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { inertWidgetHtml, safeWidgetClass } from "./safety";

// Stand-ins for the widget library's StringView and HTMLView.
class StringView {
  updated = 0;
  update() {
    this.updated += 1;
  }
}
class HTMLView extends StringView {
  content = document.createElement("div");
  model: any;
  constructor(value: string) {
    super();
    this.model = { get: () => value };
  }
  update() {
    this.content.innerHTML = this.model.get("value");
    super.update();
  }
}

describe("widget HTML", () => {
  it("keeps markup but nothing active", () => {
    const nodes = inertWidgetHtml(
      '<b id="k">bold</b><img src="a.png" onerror="x()"><a href="javascript:x()">l</a><style>body{}</style><form><input></form><svg><a><animate attributeName="href" values="0;javascript:x()"></animate></a></svg><iframe srcdoc="x"></iframe>',
      document,
    );
    const div = document.createElement("div");
    div.append(...nodes);
    expect(div.querySelector("#k")?.textContent).toBe("bold");
    expect(div.querySelector("img")?.getAttribute("src")).toBe("a.png");
    expect(div.querySelector("img")?.hasAttribute("onerror")).toBe(false);
    expect(div.querySelector("a")?.hasAttribute("href")).toBe(false);
    expect(div.querySelector("style, form, animate, iframe")).toBeNull();
  });

  it("the HTML views render inertly, then run the rest of their update", () => {
    const Safe = safeWidgetClass(
      "HTMLView",
      "@jupyter-widgets/controls",
      HTMLView,
    );
    const view = new Safe('<i>hi</i><img src="a.png" onerror="x()">');
    const set = jest.spyOn(view.content, "innerHTML", "set");
    view.update();
    expect(set).not.toHaveBeenCalled();
    expect(view.content.querySelector("i")?.textContent).toBe("hi");
    expect(view.content.querySelector("img")?.hasAttribute("onerror")).toBe(
      false,
    );
    expect(view.updated).toBe(1);
  });

  it("leaves other classes alone", () => {
    expect(
      safeWidgetClass("IntSliderView", "@jupyter-widgets/controls", HTMLView),
    ).toBe(HTMLView);
    expect(safeWidgetClass("HTMLView", "k3d", HTMLView)).toBe(HTMLView);
  });
});
