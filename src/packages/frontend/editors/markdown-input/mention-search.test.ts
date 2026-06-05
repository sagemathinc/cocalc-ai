/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { normalizeMentionSearch } from "./mention-search";

describe("normalizeMentionSearch", () => {
  it("treats the initial at-sign as an empty mention search", () => {
    expect(normalizeMentionSearch("@")).toBe("");
  });

  it("strips the mention marker before filtering users", () => {
    expect(normalizeMentionSearch("@Bella")).toBe("bella");
  });

  it("keeps ordinary typed search text unchanged except for case", () => {
    expect(normalizeMentionSearch("  Andrey ")).toBe("andrey");
  });
});
