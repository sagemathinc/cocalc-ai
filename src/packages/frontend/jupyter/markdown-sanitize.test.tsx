/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment jsdom */

// Markdown cells render with MostlyStaticMarkdown (cell-input.tsx) under the
// notebook's FileContext (cell-list.tsx), which is the same trusted or not.

import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import MostlyStaticMarkdown from "@cocalc/frontend/editors/slate/mostly-static-markdown";
import { FileContext } from "@cocalc/frontend/lib/file-context";

// The deepest element with exactly this text (Markdown adds wrappers).
function innermost(
  container: HTMLElement,
  tag: string,
  text: string,
): HTMLElement {
  const all = Array.from(container.querySelectorAll<HTMLElement>(tag)).filter(
    (e) => e.textContent?.trim() === text,
  );
  return all[all.length - 1];
}

const NOTEBOOK_CONTEXT = { noSanitize: false, allowSafeStyles: true };

function renderMarkdown(value: string) {
  return render(
    <FileContext.Provider value={NOTEBOOK_CONTEXT}>
      <MostlyStaticMarkdown value={value} />
    </FileContext.Provider>,
  );
}

describe("notebook Markdown", () => {
  it("is always sanitized, whatever the notebook's trust", () => {
    const source = readFileSync(join(__dirname, "cell-list.tsx"), "utf8");
    expect(source).toMatch(/noSanitize: false,\s*allowSafeStyles: true,/);
    expect(source).not.toMatch(/noSanitize: !*trust/);
  });

  it("keeps an instructor's styled and presentational markup", () => {
    const { container } = renderMarkdown(
      [
        '<div style="background-color: #ffffcc; border: 1px solid #cc0; padding: 8px">',
        'Note: <font color="red">important</font>',
        "</div>",
        "",
        '<table><tbody><tr><td colspan="2" align="center">wide</td></tr></tbody></table>',
        "",
        "<details><summary>Solution</summary>hidden answer</details>",
        "",
      ].join("\n"),
    );
    const box = innermost(container, "div", "Note: important");
    expect(box.style.backgroundColor).toBe("rgb(255, 255, 204)");
    expect(box.style.padding).toBe("8px");
    expect(container.querySelector("font")?.getAttribute("color")).toBe("red");
    const td = container.querySelector("td");
    expect(td?.getAttribute("colspan")).toBe("2");
    expect(td?.getAttribute("align")).toBe("center");
    expect(container.querySelector("details summary")?.textContent).toBe(
      "Solution",
    );
  });

  it("drops what could cover the app, load things or run", () => {
    const { container } = renderMarkdown(
      [
        '<div class="ant-modal" style="position: fixed; inset: 0; z-index: 9999; color: green">overlay</div>',
        "",
        '<div style="background: url(https://evil.example/t.png)">tracker</div>',
        "",
        '<img src="x" onerror="alert(1)">',
        "",
        "<style>body { display: none }</style>",
        "",
        '<a href="javascript:alert(1)" style="color: red">link</a>',
        "",
      ].join("\n"),
    );
    const html = container.innerHTML;
    expect(html).not.toMatch(
      /position|z-index|inset|url\(|onerror|ant-modal|javascript:|display: none/,
    );
    const overlay = innermost(container, "div", "overlay");
    expect(overlay.style.color).toBe("green");
    expect(container.querySelector("style")).toBeNull();
  });
});
