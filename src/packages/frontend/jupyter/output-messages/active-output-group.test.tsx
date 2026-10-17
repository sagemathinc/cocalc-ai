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

  const sel = (m) => (m.get("data") ? select(m) : undefined);

  it("groups selected JS and HTML in order, by position", () => {
    const messages = [
      fromJS({ name: "stdout", text: "a" }),
      bundle({ "text/html": "<div id=t></div>" }),
      bundle({ "application/javascript": "f()" }),
    ];
    const group = activeGroup(messages as any, sel)!;
    expect(group.map((o) => [o.kind, o.index])).toEqual([
      ["html", 1],
      ["javascript", 2],
    ]);
  });

  it("carries stdout/stderr between frame outputs into the frame; errors stay out", () => {
    const messages = [
      bundle({ "text/html": "<div id=t></div>" }),
      fromJS({ name: "stdout", text: "between" }),
      fromJS({ name: "stderr", text: "warn" }),
      fromJS({ traceback: ["Err: boom"], ename: "Err", evalue: "boom" }),
      bundle({ "application/javascript": "f()" }),
      fromJS({ name: "stdout", text: "after" }),
    ];
    const group = activeGroup(messages as any, sel)!;
    expect(group.map((o) => [o.kind, o.index, o.className])).toEqual([
      ["html", 0, undefined],
      ["text", 1, "output_stdout"],
      ["text", 2, "output_stderr"],
      ["javascript", 4, undefined],
    ]);
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

  it("an error between grouped outputs keeps the cell's error tooling", async () => {
    const AIError = ({ traceback }) => (
      <div data-testid="ai-error">{traceback}</div>
    );
    const withError = fromJS({
      0: { output_type: "display_data", data: { "text/html": "<b>h</b>" } },
      1: {
        output_type: "error",
        ename: "ValueError",
        evalue: "bad",
        traceback: ["ValueError: bad"],
      },
      2: {
        output_type: "display_data",
        data: { "application/javascript": "f()" },
      },
    });
    const { getByTestId, container } = render(
      <CellOutputMessages
        output={withError}
        trust
        id="cell1"
        actions={{ store: { getIn: () => "x = 1" } }}
        aiTools={{ toolComponents: { AIError } } as any}
      />,
    );
    await act(async () => {});
    expect(getByTestId("ai-error").textContent).toContain("ValueError: bad");
    // the error itself still renders in the notebook (outside the frame)
    expect(container.textContent).toContain("ValueError");
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
