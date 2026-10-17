/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment jsdom */

import { FRAMED, INLINE } from "./html-fidelity.test.cases";
import { sanitizedHtmlIsFaithful } from "./html-fidelity";

describe("sanitizedHtmlIsFaithful (browser)", () => {
  it.each(INLINE)("inline: %s", (_, html) => {
    expect(sanitizedHtmlIsFaithful(html)).toBe(true);
  });
  it.each(FRAMED)("framed: %s", (_, html) => {
    expect(sanitizedHtmlIsFaithful(html)).toBe(false);
  });
});
