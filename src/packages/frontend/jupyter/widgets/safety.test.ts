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

  it("keeps only http(s), mailto and image-data URLs, however written", () => {
    const div = document.createElement("div");
    div.append(
      ...inertWidgetHtml(
        '<a id="a1" href="https://e.example/x" target="_blank">ok</a>' +
          '<a id="a2" href="java\tscript:x()">t</a>' +
          '<a id="a3" href=" JAVASCRIPT:x()">u</a>' +
          '<a id="a4" href="data:text/html,x">d</a>' +
          '<a id="a5" href="relative/path">r</a>' +
          '<img id="i1" src="data:image/png;base64,AAAA" srcset="x 1x">' +
          '<svg><a id="s1" xlink:href="javascript:x()"><text>s</text></a></svg>' +
          '<p id="p1" style="position:fixed;inset:0">over</p>',
        document,
      ),
    );
    const href = (id: string) =>
      div.querySelector(`#${id}`)?.getAttribute("href");
    expect(href("a1")).toBe("https://e.example/x");
    expect(div.querySelector("#a1")?.getAttribute("rel")).toBe(
      "noopener noreferrer",
    );
    expect(href("a2")).toBeNull();
    expect(href("a3")).toBeNull();
    expect(href("a4")).toBeNull();
    expect(href("a5")).toBe("relative/path");
    expect(div.querySelector("#i1")?.getAttribute("src")).toBe(
      "data:image/png;base64,AAAA",
    );
    expect(div.querySelector("#i1")?.hasAttribute("srcset")).toBe(false);
    expect(div.querySelector("#s1")?.getAttributeNames()).toEqual(["id"]);
    expect(div.querySelector("#p1")?.hasAttribute("style")).toBe(false);
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
    expect(view.content.style.contain).toBe("paint");
  });

  it("leaves other classes alone", () => {
    expect(
      safeWidgetClass("IntSliderView", "@jupyter-widgets/controls", HTMLView),
    ).toBe(HTMLView);
    expect(safeWidgetClass("HTMLView", "k3d", HTMLView)).toBe(HTMLView);
  });
});
