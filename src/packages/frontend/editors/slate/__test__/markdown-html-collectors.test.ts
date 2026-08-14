/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import "../elements/types";
import { markdown_to_slate } from "../markdown-to-slate";

describe("markdown HTML collectors", () => {
  it.each([
    "- item\n\n  <details>\n\n  inside\n\n  </details>\n\n- next",
    "> <details>\n>\n> inside\n>\n> </details>\n\nafter",
    "<details>\n\n- item\n\n</details>\n\nafter",
    '1. <a href="https://example.com">linked item</a>\n2. next',
  ])(
    "parses nested HTML without corrupting parent collection state",
    (markdown) => {
      expect(() => markdown_to_slate(markdown, false, {})).not.toThrow();
    },
  );
});
