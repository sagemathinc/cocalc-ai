/** @jest-environment jsdom */

import {
  combinedComposerTargetStorageKey,
  readStoredCombinedComposerTargetKey,
  resolveCombinedComposerTargetKey,
} from "../combined-composer-target";

describe("combined-feed composer target", () => {
  const threads = [{ key: "200" }, { key: "100" }];

  it("preserves an explicit target while temporarily leaving combined view", () => {
    expect(resolveCombinedComposerTargetKey("100", null, threads, false)).toBe(
      "100",
    );
  });

  it("defaults to the newest thread when entering combined view without a target", () => {
    expect(resolveCombinedComposerTargetKey(null, null, threads, true)).toBe(
      "200",
    );
  });

  it("falls back to the newest thread when the saved target no longer exists", () => {
    expect(resolveCombinedComposerTargetKey("999", null, threads, true)).toBe(
      "200",
    );
  });

  it("restores the stored target when re-entering combined view", () => {
    expect(resolveCombinedComposerTargetKey(null, "100", threads, true)).toBe(
      "100",
    );
  });

  it("prefers the current in-memory target over stored state", () => {
    expect(resolveCombinedComposerTargetKey("200", "100", threads, true)).toBe(
      "200",
    );
  });

  it("clears the target when no threads remain", () => {
    expect(resolveCombinedComposerTargetKey("100", null, [], true)).toBeNull();
    expect(resolveCombinedComposerTargetKey("100", null, [], false)).toBeNull();
  });

  it("builds a stable storage key for the combined draft bucket", () => {
    expect(combinedComposerTargetStorageKey("proj", "file.chat")).toBe(
      "chat-composer-target:proj:file.chat:0",
    );
  });

  it("reads only non-empty string targets from local storage", () => {
    expect(readStoredCombinedComposerTargetKey(" 100 ")).toBe("100");
    expect(readStoredCombinedComposerTargetKey("   ")).toBeNull();
    expect(readStoredCombinedComposerTargetKey({ key: "100" })).toBeNull();
    expect(readStoredCombinedComposerTargetKey(null)).toBeNull();
  });
});
