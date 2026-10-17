/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

// Static export (nbviewer/export.ts) renders HTML output in Node, where no
// effect ever runs: nothing could size a frame to its content.  Styled output
// renders inline under the exporter's own policy, as before trust-free
// notebooks; tightening that policy (the html-ssr safety floor) is separate.

import exportToHTML from "@cocalc/frontend/jupyter/nbviewer/export";
import { STATIC_RESIZE_LISTENER } from "./autosized-iframe";

function exportOutputs(...html: string[]): string {
  return exportToHTML({
    title: "t",
    cocalcJupyter: {
      cellList: ["a"],
      cells: {
        a: {
          id: "a",
          cell_type: "code",
          input: "x",
          exec_count: 1,
          output: Object.fromEntries(
            html.map((h, n) => [n, { data: { "text/html": h } }]),
          ),
        },
      },
      kernelspec: {
        name: "python3",
        display_name: "Python 3",
        language: "python",
      },
    },
  });
}

function iframes(doc: string): number {
  return (doc.match(/<iframe/g) ?? []).length;
}

describe("HTML output in static export", () => {
  it("renders plain HTML inline", () => {
    const doc = exportOutputs("<b>plain-bold</b>");
    expect(doc).toContain("<b>plain-bold</b>");
    expect(iframes(doc)).toBe(0);
  });

  it("renders styled HTML inline (no frame it could not size)", () => {
    const doc = exportOutputs(
      '<table border="1"><tr><td style="color:red" onclick="x()">styled-cell</td></tr></table>',
    );
    expect(iframes(doc)).toBe(0);
    expect(doc).toMatch(/<td style="color:red">styled-cell<\/td>/);
    expect(doc).not.toContain("onclick");
  });

  it("frames isolated output, and the document sizes its frames", () => {
    const doc = exportOutputs(
      '<div id="p"></div><script>window.PLOTLYENV = {};</script>',
    );
    expect(iframes(doc)).toBe(1);
    expect(doc).toMatch(
      /<iframe[^>]*sandbox="allow-forms allow-scripts allow-presentation"/,
    );
    expect(doc).toContain(STATIC_RESIZE_LISTENER);
  });
});
