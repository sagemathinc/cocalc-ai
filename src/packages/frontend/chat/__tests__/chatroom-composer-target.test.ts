/** @jest-environment jsdom */

import { resolveCombinedComposerTargetKey } from "../combined-composer-target";

describe("combined-feed composer target", () => {
  const threads = [{ key: "200" }, { key: "100" }];

  it("preserves an explicit target while temporarily leaving combined view", () => {
    expect(resolveCombinedComposerTargetKey("100", threads, false)).toBe("100");
  });

  it("defaults to the newest thread when entering combined view without a target", () => {
    expect(resolveCombinedComposerTargetKey(null, threads, true)).toBe("200");
  });

  it("falls back to the newest thread when the saved target no longer exists", () => {
    expect(resolveCombinedComposerTargetKey("999", threads, true)).toBe("200");
  });

  it("clears the target when no threads remain", () => {
    expect(resolveCombinedComposerTargetKey("100", [], true)).toBeNull();
    expect(resolveCombinedComposerTargetKey("100", [], false)).toBeNull();
  });
});
