/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { render } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { FileContext } from "@cocalc/frontend/lib/file-context";
import { MarkdownInput } from "./main";

function renderRendered(value: string) {
  // Project editors set noSanitize; the course fields must sanitize anyway.
  return render(
    <IntlProvider locale="en" messages={{}}>
      <FileContext.Provider value={{ noSanitize: true }}>
        <MarkdownInput default_value={value} />
      </FileContext.Provider>
    </IntlProvider>,
  ).container;
}

describe("MarkdownInput rendered view", () => {
  it("does not activate template contents", () => {
    const root = renderRendered(
      `<template><iframe srcdoc="<script>parent.__xss=1</script>"></iframe><img src=x onerror="parent.__xss=2"></template>`,
    );
    expect(root.querySelector("iframe")).toBeNull();
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("template")).toBeNull();
    expect(root.innerHTML).not.toContain("onerror");
  });

  it("applies the central attribute policy", () => {
    const root = renderRendered(
      `<div style="position:fixed" id="x" class="y" data-a="1" onclick="z">hi</div> <img src="javascript:alert(1)" onerror="z"> <iframe srcdoc="x"></iframe>`,
    );
    const div = Array.from(root.querySelectorAll("div")).find(
      (d) => d.textContent === "hi",
    )!;
    expect(div).toBeTruthy();
    expect(div.getAttributeNames()).toEqual([]);
    const img = root.querySelector("img");
    expect(img?.getAttribute("src")).toBeNull();
    expect(img?.getAttribute("onerror")).toBeNull();
    const iframe = root.querySelector("iframe");
    // The central policy keeps no srcdoc and only vetted iframe hosts.
    expect(iframe?.getAttribute("srcdoc") ?? null).toBeNull();
    expect(iframe?.getAttribute("src") ?? null).toBeNull();
  });

  it("keeps formatting, task checkboxes (disabled) and links", () => {
    const root = renderRendered(
      "# Title\n\n- [x] done\n- [ ] todo\n\n**bold** [link](https://example.com)",
    );
    expect(root.querySelector("h1")?.textContent).toBe("Title");
    expect(root.querySelector("strong")?.textContent).toBe("bold");
    expect(root.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com",
    );
    const boxes = Array.from(
      root.querySelectorAll("input"),
    ) as HTMLInputElement[];
    expect(boxes.length).toBe(2);
    for (const box of boxes) {
      expect(box.type).toBe("checkbox");
      expect(box.disabled).toBe(true);
    }
    expect(boxes[0].checked).toBe(true);
    expect(boxes[1].checked).toBe(false);
  });

  it("drops non-checkbox inputs", () => {
    const root = renderRendered(
      `<input type="text" value="x"> <input type="image" src="x" onerror="z">`,
    );
    expect(root.querySelector("input")).toBeNull();
  });

  it("renders math and keeps escaped markup next to it as text", () => {
    const root = renderRendered(
      "Let $x^2$ and &lt;img src=x onerror=z&gt; $$y$$",
    );
    expect(root.querySelector(".katex")).not.toBeNull();
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("<img src=x onerror=z>");
  });
});
