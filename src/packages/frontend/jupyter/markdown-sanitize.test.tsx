/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment jsdom */

// Everything a notebook renders with the Markdown or HTML renderers is
// sanitized, trusted or not, keeping safe styles (notebook-file-context.tsx);
// only text/html output keeps its old context for now.  (Several of these
// cases come from @lite4-opus-review's repros for PR #20.)

import { render } from "@testing-library/react";
import { fromJS } from "immutable";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import MostlyStaticMarkdown from "@cocalc/frontend/editors/slate/mostly-static-markdown";
import { FileContext } from "@cocalc/frontend/lib/file-context";
import { CellOutputMessages } from "./output-messages/message";
import { NotebookFileContext } from "./notebook-file-context";
import Html from "./output-messages/mime-types/html";
// The registration order of a live notebook: the editor chunk (jupyter/main.tsx)
// loads init-frontend, then the actions chunk (browser-actions.ts imports
// nbviewer/export) loads init-nbviewer, whose handlers replace some of the
// first ones.
import "./output-messages/mime-types/init-frontend";
import "./nbviewer/notebook";

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

function inNotebook(trust: boolean, ui) {
  return render(<NotebookFileContext trust={trust}>{ui}</NotebookFileContext>);
}

function output(data: object, trust = true) {
  return inNotebook(
    trust,
    <CellOutputMessages
      output={fromJS({ 0: { output_type: "display_data", data } })}
      trust={trust}
    />,
  );
}

describe("the notebook's context", () => {
  it("is what cell-list.tsx provides", () => {
    const source = readFileSync(join(__dirname, "cell-list.tsx"), "utf8");
    expect(source).toMatch(/<NotebookFileContext\s+trust=\{trust\}/);
    expect(source).not.toMatch(/noSanitize:/);
  });
});

describe.each([true, false])("trusted: %s", (trust) => {
  it("Markdown cells keep safe styles and drop the rest", () => {
    const styled = inNotebook(trust, <MostlyStaticMarkdown value={STYLED} />);
    expectStyledKept(styled.container);
    const hostile = inNotebook(trust, <MostlyStaticMarkdown value={HOSTILE} />);
    expectHostileStripped(hostile.container);
  });

  it.each(["text/markdown", "text/latex"])(
    "%s output keeps safe styles and drops the rest",
    (type) => {
      expectStyledKept(output({ [type]: STYLED }, trust).container);
      expectHostileStripped(output({ [type]: HOSTILE }, trust).container);
    },
  );
});

describe("text/html output keeps its old context (until #19)", () => {
  const RICH = '<div class="widget-x" id="w1" style="color: blue">rich</div>';

  it("trusted: as before, not sanitized", () => {
    const div = innermost(
      output({ "text/html": RICH }, true).container,
      "div",
      "rich",
    );
    expect(div.getAttribute("class")).toBe("widget-x");
    expect(div.getAttribute("id")).toBe("w1");
  });

  it("untrusted: as before, sanitized without safe styles", () => {
    const div = innermost(
      output({ "text/html": RICH }, false).container,
      "div",
      "rich",
    );
    expect(div.getAttributeNames()).toEqual([]);
  });

  // init-frontend's handler, which output-messages/iframe.tsx also renders
  // for small trusted blob HTML
  it.each([true, false])(
    "the init-frontend handler too (trusted: %s)",
    (trust) => {
      const { container } = inNotebook(trust, <Html value={RICH} />);
      const div = innermost(container, "div", "rich");
      if (trust) {
        expect(div.getAttribute("class")).toBe("widget-x");
      } else {
        expect(div.getAttributeNames()).toEqual([]);
      }
    },
  );

  it("outside a notebook (e.g., the public viewer): context unchanged", () => {
    const { container } = render(
      <FileContext.Provider value={{ noSanitize: true }}>
        <CellOutputMessages
          output={fromJS({
            0: { output_type: "display_data", data: { "text/html": RICH } },
          })}
        />
      </FileContext.Provider>,
    );
    expect(innermost(container, "div", "rich").getAttribute("class")).toBe(
      "widget-x",
    );
  });
});

describe("Slate marks", () => {
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
    const { container } = inNotebook(
      true,
      <MostlyStaticMarkdown value={`Text ${html} after.`} />,
    );
    expect(container.innerHTML).not.toMatch(
      /var\(|url\(|expression|\\61|\/\*|position/,
    );
    expect(container.textContent).toContain("m");
  });

  it("keeps a valid mark value", () => {
    const { container } = inNotebook(
      true,
      <MostlyStaticMarkdown value='Text <span style="color:#ff0000">red</span> and <span style="font-size:20px">big</span>.' />,
    );
    expect(innermost(container, "span", "red").style.color).toBe(
      "rgb(255, 0, 0)",
    );
    expect(innermost(container, "span", "big").style.fontSize).toBe("20px");
  });
});

it("passes a safe link style to a custom anchor as a style object", () => {
  const seen: any[] = [];
  const Anchor = (props) => {
    seen.push(props.style);
    return <a href={props.href}>{props.children}</a>;
  };
  render(
    <FileContext.Provider value={{ AnchorTagComponent: Anchor }}>
      <NotebookFileContext trust>
        <MostlyStaticMarkdown value='<div><a href="https://example.com" style="color: red; position: fixed">l</a></div>' />
      </NotebookFileContext>
    </FileContext.Provider>,
  );
  expect(seen).toContainEqual({ color: "red" });
});
