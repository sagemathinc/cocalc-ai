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

  it("canonicalizes Microsoft plus aliases without dot normalization", () => {
    expect(canonicalEmailForBanEquivalence("Co.Dex+abuse@outlook.com")).toBe(
      "co.dex@outlook.com",
    );
    expect(canonicalEmailForBanEquivalence("codex+abuse@hotmail.com")).toBe(
      "codex@hotmail.com",
    );
  });

  it("canonicalizes Proton plus aliases without cross-domain merging", () => {
    expect(canonicalEmailForBanEquivalence("codex+abuse@proton.me")).toBe(
      "codex@proton.me",
    );
    expect(canonicalEmailForBanEquivalence("codex+abuse@pm.me")).toBe(
      "codex@pm.me",
    );
  });

  it("canonicalizes Yahoo disposable address nicknames", () => {
    expect(canonicalEmailForBanEquivalence("codex-abuse@yahoo.com")).toBe(
      "codex-*@yahoo.com",
    );
    expect(canonicalEmailForBanEquivalence("codex@yahoo.com")).toBe(undefined);
  });

  it("does not infer provider-specific equivalence for arbitrary domains", () => {
    expect(canonicalEmailForBanEquivalence("codex+abuse@example.com")).toBe(
      undefined,
    );
  });
});
