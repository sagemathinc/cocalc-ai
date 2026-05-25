/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { canonicalEmailForBanEquivalence } from "./cluster-directory";

describe("ban email equivalence", () => {
  it("canonicalizes Gmail plus and dot aliases", () => {
    expect(canonicalEmailForBanEquivalence("Co.Dex+abuse@googlemail.com")).toBe(
      "codex@gmail.com",
    );
  });

  it("does not infer provider-specific equivalence for arbitrary domains", () => {
    expect(canonicalEmailForBanEquivalence("codex+abuse@example.com")).toBe(
      undefined,
    );
  });
});
