/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import "../elements/types";

import { markdown_to_slate } from "../markdown-to-slate";
import { slate_to_markdown } from "../slate-to-markdown";

const roundTrip = (markdown: string) =>
  slate_to_markdown(markdown_to_slate(markdown));

describe("a table row with more cells than its header", () => {
  it("keeps the extra text through a rich-text save", () => {
    const once = roundTrip("| x | y |\n| - | - |\n| a | b | extra\n");
    expect(once).toContain("extra");
    expect(once).toContain("| a | b \\| extra |");
    // ... and the saved form is stable.
    expect(roundTrip(once)).toBe(once);
  });

  it("keeps extra whole cells", () => {
    const once = roundTrip("| x | y |\n| - | - |\n| a | b | c | d |\n");
    expect(once).toContain("| a | b \\| c \\| d |");
    expect(roundTrip(once)).toBe(once);
  });

  it("keeps a pipe inside a cell, in text or code, inside that cell", () => {
    const once = roundTrip("| x | y |\n| - | - |\n| a \\| b | `c \\| d` |\n");
    expect(once).toContain("| a \\| b | `c \\| d` |");
    expect(roundTrip(once)).toBe(once);
  });
});
