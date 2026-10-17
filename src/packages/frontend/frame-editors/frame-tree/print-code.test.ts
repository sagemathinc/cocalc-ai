/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

jest.mock("@cocalc/frontend/codemirror/static", () => ({
  __esModule: true,
  default: {
    runMode: (
      value: string,
      mode: string,
      append: (text: string, type?: string) => void,
    ) => append(value, mode === "stex" ? "keyword" : undefined),
  },
}));

import { print_code, renderPrintableCodeMarkup } from "./print-code";
import { PASSIVE_DOCUMENT_CSP } from "@cocalc/frontend/misc/print-document";

describe("renderPrintableCodeMarkup", () => {
  it("preserves plain CodeMirror options while forcing the printable theme", () => {
    const html = renderPrintableCodeMarkup({
      value: "\\documentclass{article}",
      options: {
        lineNumbers: true,
        lineWrapping: false,
        mode: "stex",
        theme: "cocalc-light",
      },
    });

    expect(html).toContain("cm-s-default");
    expect(html).toContain("cm-keyword");
    expect(html).toContain("CodeMirror-linenumber");
    expect(html).toContain("white-space:pre");
    expect(html).not.toContain("cm-s-cocalc-light");
  });
});

describe("print_code", () => {
  it("writes a script-free document with an escaped title", () => {
    const written: string[] = [];
    const w = {
      closed: false,
      window: { print: () => {} } as any,
      document: { write: (t: string) => written.push(t), close: () => {} },
    };
    const open = jest.spyOn(window, "open").mockReturnValue(w as any);
    try {
      print_code({
        value: "x = 1",
        options: { mode: "python" },
        path: "dir/<img src=x onerror=alert(1)>.py",
      });
    } finally {
      open.mockRestore();
    }
    const doc = written.join("");
    expect(doc.indexOf(PASSIVE_DOCUMENT_CSP)).toBeGreaterThan(-1);
    expect(doc.indexOf(PASSIVE_DOCUMENT_CSP)).toBeLessThan(
      doc.indexOf("<title>"),
    );
    expect(doc).toContain(
      "<title>&lt;img src=x onerror=alert(1)&gt;.py</title>",
    );
    expect(doc).not.toContain("<img");
  });
});
