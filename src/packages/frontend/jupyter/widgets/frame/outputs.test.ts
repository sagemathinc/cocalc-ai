/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

jest.mock("./math", () => ({ typesetMath: jest.fn() }));

import { outputKind, renderOutput } from "./outputs";

function render(output: any): HTMLElement {
  const div = document.createElement("div");
  renderOutput(output, div);
  return div;
}

describe("Output widget content in the frame", () => {
  // What capture_output_message stores: the messages' content, without
  // output_type (ipywidgets docs, "Output widgets: leveraging Jupyter's
  // display system").
  it("renders captured stream content", () => {
    const div = render({ name: "stdout", text: "0 Hello world!\n" });
    expect(div.querySelector("pre.output_stdout")?.textContent).toBe(
      "0 Hello world!\n",
    );
    expect(
      render({ name: "stderr", text: "oops" }).querySelector(
        "pre.output_stderr",
      ),
    ).not.toBeNull();
  });

  it("merges consecutive chunks of one stream into one block", () => {
    const div = document.createElement("div");
    for (let i = 0; i < 3; i++) {
      renderOutput({ name: "stdout", text: `${i} Hello world!\n` }, div);
    }
    renderOutput({ name: "stderr", text: "warning\n" }, div);
    const pres = div.querySelectorAll("pre");
    expect(pres).toHaveLength(2);
    expect(pres[0].textContent).toBe(
      "0 Hello world!\n1 Hello world!\n2 Hello world!\n",
    );
    expect(pres[1].className).toBe("output_stderr");
  });

  it("renders captured display data and errors", () => {
    expect(
      render({ data: { "text/plain": "42" }, metadata: {} }).textContent,
    ).toBe("42");
    expect(
      render({
        data: { "text/html": "<b>hi</b>" },
        metadata: {},
      }).querySelector("b")?.textContent,
    ).toBe("hi");
    expect(
      render({ data: { "image/png": "iVBORw0KGgo=" }, metadata: {} })
        .querySelector("img")
        ?.getAttribute("src"),
    ).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(
      render({
        ename: "ValueError",
        evalue: "x",
        traceback: ["Traceback", "ValueError: x"],
      }).querySelector("pre.output_stderr")?.textContent,
    ).toBe("Traceback\nValueError: x");
  });

  it("renders a widget displayed inside an Output widget with the frame's manager", () => {
    const renderWidget = jest.fn(async () => {});
    const div = document.createElement("div");
    renderOutput(
      {
        data: {
          "application/vnd.jupyter.widget-view+json": {
            model_id: "m1",
            version_major: 2,
          },
          "text/plain": "IntSlider(value=0)",
        },
        metadata: {},
      },
      div,
      renderWidget,
    );
    expect(renderWidget).toHaveBeenCalledWith("m1", expect.any(HTMLElement));
    expect(div.textContent).toBe("");
  });

  it("still understands full nbformat outputs", () => {
    expect(
      outputKind({ output_type: "stream", name: "stdout", text: "a" }),
    ).toBe("stream");
    expect(outputKind({ output_type: "execute_result", data: {} })).toBe(
      "data",
    );
    expect(outputKind({ output_type: "error", ename: "E" })).toBe("error");
  });
});
