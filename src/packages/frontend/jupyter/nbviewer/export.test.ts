/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import parse from "@cocalc/jupyter/ipynb/parse";
import { PASSIVE_DOCUMENT_CSP } from "@cocalc/frontend/misc/print-document";
import exportToHTML, { PRINT_CSS, exportToHTMLParts } from "./export";

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

const cocalcJupyter = {
  cells: {},
  cellList: [],
  metadata: {},
  kernelspec: { display_name: "Python 3", name: "python3", language: "python" },
} as any;

describe("exportToHTML", () => {
  it("blocks scripts only when passive", () => {
    const passive = exportToHTML({
      cocalcJupyter,
      title: "a.ipynb",
      passive: true,
    });
    expect(passive).toContain(PASSIVE_DOCUMENT_CSP);
    expect(passive.indexOf(PASSIVE_DOCUMENT_CSP)).toBeLessThan(
      passive.indexOf("<body>"),
    );
    const trusted = exportToHTML({ cocalcJupyter, title: "a.ipynb" });
    expect(trusted).not.toContain(PASSIVE_DOCUMENT_CSP);
  });

  it("escapes the title", () => {
    const html = exportToHTML({
      cocalcJupyter,
      title: "<img src=x onerror=1>.ipynb",
    });
    expect(html).toContain("<title>&lt;img src=x onerror=1&gt;.ipynb</title>");
  });

  it("returns parts for writePassiveDocument", () => {
    const parts = exportToHTMLParts({ cocalcJupyter, title: "a.ipynb" });
    expect(parts.title).toBe("a.ipynb");
    expect(parts.head).toContain('rel="stylesheet"');
    expect(parts.head).not.toContain("<title");
    expect(parts.body).toContain("Python 3");
  });
});
