/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import parse from "@cocalc/jupyter/ipynb/parse";
import exportToHTML, { PRINT_CSS } from "./export";

// Printing a notebook (Jupyter > Print) renders this HTML in a popup. A
// markdown image moved to the next page used to be painted over the cells
// after it; the print stylesheet lifts the image's max-height cap.
describe("exportToHTML print stylesheet", () => {
  const ipynb = JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      {
        cell_type: "markdown",
        metadata: {},
        source: "A plot:\n\n![](https://example.com/plot.png)",
      },
    ],
  });

  it("lifts the max-height cap of markdown images when printing", () => {
    const html = exportToHTML({ cocalcJupyter: parse(ipynb), title: "t" });
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).toContain(`<style>${PRINT_CSS}</style>`);
    expect(PRINT_CSS).toMatch(
      /^@media print \{ \.cocalc-slate-render img \{ max-height: none !important; \} \}$/,
    );
    // The selector must match how markdown images are actually rendered.
    const doc = new DOMParser().parseFromString(html, "text/html");
    const img = doc.querySelector(".cocalc-slate-render img") as HTMLElement;
    expect(img?.getAttribute("src")).toBe("https://example.com/plot.png");
    expect(img.style.maxHeight).toBe("100%");
  });
});
