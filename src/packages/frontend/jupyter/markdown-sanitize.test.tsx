/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment jsdom */

// Notebook Markdown -- cells (cell-input.tsx) and text/markdown output -- is
// sanitized whatever the notebook's trust, keeping safe styles.  Other output
// (text/html) still follows the notebook's context (cell-list.tsx).

import { render } from "@testing-library/react";
import { fromJS } from "immutable";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import MostlyStaticMarkdown from "@cocalc/frontend/editors/slate/mostly-static-markdown";
import { FileContext } from "@cocalc/frontend/lib/file-context";
import { CellOutputMessages } from "./output-messages/message";
import { NotebookMarkdownContext } from "./notebook-markdown-context";
import "./output-messages/mime-types/init-frontend";

// What cell-list.tsx provides to a trusted notebook.
const TRUSTED = { noSanitize: true };

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

// A Markdown cell, as cell-input.tsx renders it.
function renderCell(value: string, AnchorTagComponent?) {
  return render(
    <FileContext.Provider value={{ ...TRUSTED, AnchorTagComponent }}>
      <NotebookMarkdownContext>
        <MostlyStaticMarkdown value={value} />
      </NotebookMarkdownContext>
    </FileContext.Provider>,
  );
}

const STYLED = [
  '<div style="background-color: #ffffcc; border: 1px solid #cc0; padding: 8px">',
  'Note: <font color="red">important</font>',
  "</div>",
  "",
  '<table><tbody><tr><td colspan="2" align="center">wide</td></tr></tbody></table>',
  "",
  "<details><summary>Solution</summary>hidden answer</details>",
  "",
].join("\n");

const HOSTILE = [
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
].join("\n");

function expectStyledKept(container: HTMLElement) {
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
}

function expectHostileStripped(container: HTMLElement) {
  expect(container.innerHTML).not.toMatch(
    /position|z-index|inset|url\(|onerror|ant-modal|javascript:|display: none/,
  );
  expect(innermost(container, "div", "overlay").style.color).toBe("green");
  expect(container.querySelector("style")).toBeNull();
}

describe("Markdown cells", () => {
  it("are wrapped in the notebook Markdown context", () => {
    const source = readFileSync(join(__dirname, "cell-input.tsx"), "utf8");
    expect(source).toMatch(/<NotebookMarkdownContext>\s*<MostlyStaticMarkdown/);
  });

  it("keep an instructor's styled and presentational markup", () => {
    expectStyledKept(renderCell(STYLED).container);
  });

  it("drop what could cover the app, load things or run, even when trusted", () => {
    expectHostileStripped(renderCell(HOSTILE).container);
  });

  // Slate turns <span style="color|font-family|font-size: ..."> into marks,
  // which render without html-ssr: the same checks must apply.
  it.each([
    ['<span style="font-size:var(--review-size)">m</span>'],
    ['<span style="color:var(--x)">m</span>'],
    ["<span style='color:url(https://evil.example/c)'>m</span>"],
    ['<span style="font-family:\\61 rial">m</span>'],
    ['<span style="font-family:a /* x */ b">m</span>'],
    ['<span style="color:red;position:fixed">m</span>'],
    ['<span style="font-size:expression(1)">m</span>'],
  ])("rejects the mark value in %s", (html) => {
    const { container } = renderCell(`Text ${html} after.`);
    expect(container.innerHTML).not.toMatch(
      /var\(|url\(|expression|\\61|\/\*|position/,
    );
    expect(container.textContent).toContain("m");
  });

  it("keeps a valid mark value", () => {
    const { container } = renderCell(
      'Text <span style="color:#ff0000">red</span> and <span style="font-size:20px">big</span>.',
    );
    expect(innermost(container, "span", "red").style.color).toBe(
      "rgb(255, 0, 0)",
    );
    expect(innermost(container, "span", "big").style.fontSize).toBe("20px");
  });

  it("pass a safe link style to a custom anchor as a style object", () => {
    const seen: any[] = [];
    const Anchor = (props) => {
      seen.push(props.style);
      return <a href={props.href}>{props.children}</a>;
    };
    renderCell(
      '<div><a href="https://example.com" style="color: red; position: fixed">l</a></div>\n',
      Anchor,
    );
    expect(seen).toContainEqual({ color: "red" });
  });
});

describe("notebook output (MIME handlers)", () => {
  function renderOutput(data: object) {
    return render(
      <FileContext.Provider value={TRUSTED}>
        <CellOutputMessages
          output={fromJS({ 0: { output_type: "display_data", data } })}
          trust
        />
      </FileContext.Provider>,
    );
  }

  it("text/markdown keeps safe styles and drops the rest, even when trusted", () => {
    expectStyledKept(renderOutput({ "text/markdown": STYLED }).container);
    expectHostileStripped(renderOutput({ "text/markdown": HOSTILE }).container);
  });

  it("text/html still follows the notebook's context", () => {
    // (unchanged here; HTML output has its own path to sanitizing, #19)
    const { container } = renderOutput({
      "text/html": '<div class="widget-x" id="w1">rich</div>',
    });
    const div = innermost(container, "div", "rich");
    expect(div.getAttribute("class")).toBe("widget-x");
    expect(div.getAttribute("id")).toBe("w1");
  });
});
