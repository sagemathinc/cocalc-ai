/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { latexMathToHtmlOrError } from "../math-to-html";

describe("latexMathToHtmlOrError", () => {
  it("adds inline fallback styles that hide katex mathml before css loads", () => {
    const { __html, err } = latexMathToHtmlOrError(
      "$\\displaystyle 1+2+3+\\dots+100 = 5050$",
    );
    expect(err).toBeUndefined();
    expect(__html).toContain('class="katex-mathml"');
    expect(__html).toContain(
      'style="clip:rect(1px,1px,1px,1px);border:0;height:1px;overflow:hidden;padding:0;position:absolute;width:1px"',
    );
    expect(__html).toContain('encoding="application/x-tex"');
  });
});
