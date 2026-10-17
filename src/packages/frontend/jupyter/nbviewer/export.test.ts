/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { PASSIVE_DOCUMENT_CSP } from "@cocalc/frontend/misc/print-document";
import exportToHTML from "./export";

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
});
