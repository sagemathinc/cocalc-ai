/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { PASSIVE_DOCUMENT_CSP, escapeHtmlText } from "./print-document";

describe("print-document", () => {
  it("blocks all document scripts", () => {
    const content = /content="([^"]*)"/.exec(PASSIVE_DOCUMENT_CSP)?.[1];
    expect(content).toContain("script-src 'none'");
    expect(content).toContain("object-src 'none'");
    expect(content).toContain("base-uri 'none'");
  });

  it("escapes text", () => {
    expect(escapeHtmlText(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });
});
