/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The frame document's behavior (incremental updates, run-once, ordering,
// isolation) needs a real browser: see active-output-group.browser-test.mjs.
// jsdom never runs srcdoc documents.

import { act, render } from "@testing-library/react";
import { fromJS } from "immutable";
import { SHELL_DOCUMENT, activeGroup } from "./active-output-group";
import { CellOutputMessages } from "./message";
import { selectMimeType } from "./mime-types/data";
import "./mime-types/init-frontend";

const bundle = (data: object) => fromJS({ output_type: "display_data", data });
const select = (m) =>
  selectMimeType(m.get("data").keySeq().toJS(), undefined, true);

describe("activeGroup uses the renderer's MIME choice", () => {
  it("is null without a selected JavaScript output", () => {
    expect(
      activeGroup([bundle({ "text/html": "<b>x</b>" })] as any, select),
    ).toBeNull();
  });

  it.each([
    ["HTML+JS", { "text/html": "<b>h</b>", "application/javascript": "x()" }],
    ["PDF+JS", { "application/pdf": "abc", "application/javascript": "x()" }],
    ["iframe+JS", { iframe: "0".repeat(40), "application/javascript": "x()" }],
  ])("%s: the higher-priority representation wins, no JS runs", (_, data) => {
    expect(activeGroup([bundle(data)] as any, select)).toBeNull();
  });

  it("JS selected over a lower-priority fallback", () => {
    const group = activeGroup(
      [
        bundle({ "application/javascript": "x()", "text/plain": "<fallback>" }),
      ] as any,
      select,
    );
    expect(group?.map((o) => o.kind)).toEqual(["javascript"]);
  });

  it("groups selected JS and HTML in order, keyed by position and content", () => {
    const messages = [
      fromJS({ name: "stdout", text: "a" }),
      bundle({ "text/html": "<div id=t></div>" }),
      bundle({ "application/javascript": "f()" }),
    ];
    const group = activeGroup(messages as any, (m) =>
      m.get("data") ? select(m) : undefined,
    )!;
    expect(group.map((o) => [o.kind, o.key.split(":")[0]])).toEqual([
      ["html", "1"],
      ["javascript", "2"],
    ]);
    const changed = activeGroup(
      [
        messages[0],
        messages[1],
        bundle({ "application/javascript": "g()" }),
      ] as any,
      (m) => (m.get("data") ? select(m) : undefined),
    )!;
    expect(changed[0].key).toBe(group[0].key);
    expect(changed[1].key).not.toBe(group[1].key);
  });
});

describe("shell document", () => {
  it("is constant and carries no output content", () => {
    expect(SHELL_DOCUMENT).toContain('<div id="cocalc-outputs"></div>');
    expect(SHELL_DOCUMENT).not.toContain("f()");
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
      data: { "application/javascript": "window.parent.__ranInApp = 1;" },
    },
    2: { name: "stdout", text: "plain text" },
  });

  it("trusted: one opaque-scripts frame with a constant shell; no output content in the page", async () => {
    const { container } = render(<CellOutputMessages output={output} trust />);
    await act(async () => {});
    const frames = container.querySelectorAll("iframe");
    expect(frames.length).toBe(1);
    expect(frames[0].getAttribute("sandbox")).toBe("allow-scripts");
    expect(frames[0].getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frames[0].getAttribute("srcdoc")).not.toContain("__ranInApp");
    expect(container.querySelector("#sib")).toBeNull();
    expect(container.textContent).toContain("plain text");
    expect((window as any).__ranInApp).toBeUndefined();
  });

  it("untrusted: JavaScript does not run at all", async () => {
    const { container } = render(
      <CellOutputMessages output={output} trust={false} />,
    );
    await act(async () => {});
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).toContain("not running untrusted Javascript");
  });
});
