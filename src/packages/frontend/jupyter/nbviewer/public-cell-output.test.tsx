/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";

jest.mock("@cocalc/frontend/jupyter/output-messages/autosized-iframe", () => ({
  __esModule: true,
  default: ({ src, srcDoc, sandbox, title }: any) => (
    <iframe src={src} srcDoc={srcDoc} sandbox={sandbox} title={title} />
  ),
}));

import PublicCellOutput, {
  PublicOutputModeContext,
} from "./public-cell-output";
import PublicNotebook from "./public-notebook";

const HOSTILE =
  `<table><tbody><tr><td>inline html</td></tr></tbody></table>` +
  `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>` +
  `<iframe srcdoc="<script>parent.__xss=3</script>"></iframe>` +
  `<div style="position:fixed" onclick="x">styled</div>`;

function cell(data: { [type: string]: any }) {
  return { output: { 0: { data } } };
}

function renderOutput(data: { [type: string]: any }, interactive = false) {
  return render(
    <PublicOutputModeContext.Provider value={{ interactive }}>
      <PublicCellOutput cell={cell(data)} />
    </PublicOutputModeContext.Provider>,
  ).container;
}

describe("PublicCellOutput HTML rendering", () => {
  it("is passive by default: sanitized, no scripts or frames", () => {
    const root = renderOutput({ "text/html": HOSTILE });
    expect(screen.getByText("inline html")).toBeInTheDocument();
    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelector("iframe[srcdoc]")).toBeNull();
    expect(root.innerHTML).not.toMatch(/onerror|onclick|position:\s*fixed/);
    expect(screen.queryByTitle("Jupyter HTML output")).toBeNull();
  });

  it("is passive by default for full HTML documents too", () => {
    const root = renderOutput({
      "text/html":
        "<html><body>document html<script>x()</script></body></html>",
    });
    expect(screen.getByText("document html")).toBeInTheDocument();
    expect(root.querySelector("script")).toBeNull();
  });

  it("prefers a static image over script-only HTML in passive mode", () => {
    const root = renderOutput({
      "text/html": `<div id="plot"></div><script>Plotly.newPlot("plot")</script>`,
      "image/png": "iVBORw0KGgo=",
    });
    expect(root.querySelector("img")?.getAttribute("src")).toMatch(
      /^data:image\/png;base64,/,
    );
  });

  it("keeps HTML without scripts even when an image exists", () => {
    renderOutput({
      "text/html": "<b>table</b>",
      "image/png": "iVBORw0KGgo=",
    });
    expect(screen.getByText("table")).toBeInTheDocument();
  });

  it("runs interactive output only in an opaque sandboxed iframe", () => {
    const root = renderOutput({ "text/html": HOSTILE }, true);
    const iframe = screen.getByTitle("Jupyter HTML output");
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.getAttribute("srcdoc")).toContain("inline html");
    // Nothing is rendered into the page itself.
    expect(root.querySelectorAll("script, img").length).toBe(0);
  });
});

describe("PublicNotebook interactive toggle", () => {
  const cocalcJupyter: any = {
    cellList: ["a"],
    cells: { a: { id: "a", input: "x", ...cell({ "text/html": HOSTILE }) } },
    metadata: {},
    kernelspec: {
      display_name: "Python 3",
      name: "python3",
      language: "python",
    },
  };

  it("starts passive and switches to sandboxed frames on request", () => {
    render(<PublicNotebook cocalcJupyter={cocalcJupyter} />);
    expect(screen.queryByTitle("Jupyter HTML output")).toBeNull();
    fireEvent.click(screen.getByText("Show interactive output"));
    expect(
      screen.getByTitle("Jupyter HTML output").getAttribute("sandbox"),
    ).toBe("allow-scripts");
    fireEvent.click(screen.getByText("Hide interactive output"));
    expect(screen.queryByTitle("Jupyter HTML output")).toBeNull();
  });
});
