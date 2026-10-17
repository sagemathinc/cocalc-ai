/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render } from "@testing-library/react";
import { fromJS } from "immutable";
import { activeGroup, groupDocument } from "./active-output-group";
import { CellOutputMessages } from "./message";
import "./mime-types/init-frontend";

const js = (code: string) =>
  fromJS({
    output_type: "display_data",
    data: { "application/javascript": code },
  });
const html = (value: string) =>
  fromJS({ output_type: "display_data", data: { "text/html": value } });
const stdout = (text: string) => fromJS({ name: "stdout", text });

describe("activeGroup", () => {
  it("is null without JavaScript output", () => {
    expect(activeGroup([html("<b>x</b>"), stdout("hi")] as any)).toBeNull();
  });

  it("groups JavaScript and HTML outputs, in order", () => {
    expect(
      activeGroup([
        stdout("a"),
        html("<div id=t></div>"),
        js("1"),
        stdout("b"),
      ] as any),
    ).toEqual([1, 2]);
  });
});

describe("groupDocument", () => {
  it("runs each JavaScript output with its own element", () => {
    const doc = groupDocument(
      [html("<div id=t></div>"), js("element.text(1)")] as any,
      [0, 1],
    );
    expect(doc).toContain('<div class="output_html"><div id=t></div></div>');
    expect(doc).toContain('id="cocalc-js-output-1"');
    expect(doc).toContain("element.text(1)");
    expect(doc).toContain('document.getElementById("cocalc-js-output-1")');
  });

  it("can't break out of its script element", () => {
    const doc = groupDocument(
      [js('x = "</script><img src=x onerror=alert(1)>"; <!-- y')] as any,
      [0],
    );
    const body = doc.slice(doc.indexOf("<body>"));
    // Exactly one script element in the body, and the payload stays inside it.
    expect(body.match(/<script>/g)?.length).toBe(1);
    expect(body.match(/<\/script>/gi)?.length).toBe(1);
    expect(body).toContain("<\\/script><img");
  });
});

describe("CellOutputMessages", () => {
  const output = fromJS({
    0: {
      output_type: "display_data",
      data: { "text/html": "<div id='sib'>before</div>" },
    },
    1: {
      output_type: "display_data",
      data: {
        "application/javascript":
          "window.parent.__ranInApp = 1; window.__ranInApp = 1;",
      },
    },
    2: { name: "stdout", text: "plain text" },
  });

  beforeEach(() => {
    delete (window as any).__ranInApp;
  });

  it("trusted: JavaScript runs only in an opaque sandboxed frame", async () => {
    const { container } = render(<CellOutputMessages output={output} trust />);
    await new Promise((r) => setTimeout(r, 400));
    const frames = container.querySelectorAll("iframe");
    expect(frames.length).toBe(1);
    const sandbox = frames[0].getAttribute("sandbox") ?? "";
    expect(frames[0].hasAttribute("sandbox")).toBe(true);
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
    expect(frames[0].getAttribute("srcdoc")).toContain("__ranInApp");
    // Nothing ran in this page, and the HTML went into the frame, not the page.
    expect((window as any).__ranInApp).toBeUndefined();
    expect(container.querySelector("#sib")).toBeNull();
    expect(container.textContent).toContain("plain text");
  });

  it("untrusted: JavaScript does not run at all", async () => {
    const { container } = render(
      <CellOutputMessages output={output} trust={false} />,
    );
    await new Promise((r) => setTimeout(r, 400));
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).toContain("not running untrusted Javascript");
    expect((window as any).__ranInApp).toBeUndefined();
  });
});
