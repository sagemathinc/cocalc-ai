/// <reference types="jest" />

import { MergeCoordinator } from "../sync";

describe("MergeCoordinator", () => {
  test("merges remote while preserving local edits", () => {
    let localBuffer = "abc";
    let applied: string | undefined;

    const coordinator = new MergeCoordinator({
      getLocal: () => localBuffer,
      applyMerged: (merged) => {
        applied = merged;
        localBuffer = merged;
      },
    });

    coordinator.seedBase("a b c", "1");
    // Local user inserts X before 'c'.
    localBuffer = "a b X c";
    // Remote appends Y.
    coordinator.mergeRemote("a b c Y", "2");

    expect(applied).toBe("a b X c Y");
    expect(localBuffer).toBe("a b X c Y");
  });

  test("preserves uncommitted local across successive remotes", () => {
    let localBuffer = "abc";
    let applied: string | undefined;

    const coordinator = new MergeCoordinator({
      getLocal: () => localBuffer,
      applyMerged: (merged) => {
        applied = merged;
        localBuffer = merged;
      },
    });

    coordinator.seedBase("a b c", "1");
    // Local edit: insert X.
    localBuffer = "a b X c";
    // First remote: append Y.
    coordinator.mergeRemote("a b c Y", "2");
    expect(applied).toBe("a b X c Y");
    // Second remote: append Z (doesn't have X).
    coordinator.mergeRemote("a b c Y Z", "3");
    expect(applied).toBe("a b X c Y Z");
    expect(localBuffer).toBe("a b X c Y Z");
  });

  test("non-overlapping edits merge (base/local/remote example)", () => {
    const base = "aaa\n\n---\n\nzzz";
    const localEdits = "aaa\n\n---\n\nzzzxxx"; // local appends xxx
    const remoteEdits = "aaaeee\n\n---\n\nzzz"; // remote inserts eee near start

    let localBuffer = localEdits;
    let applied: string | undefined;
    const coordinator = new MergeCoordinator({
      getLocal: () => localBuffer,
      applyMerged: (merged) => {
        applied = merged;
        localBuffer = merged;
      },
    });
    coordinator.seedBase(base, "1");
    coordinator.mergeRemote(remoteEdits, "2");
    expect(applied).toBe("aaaeee\n\n---\n\nzzzxxx");
    expect(localBuffer).toBe("aaaeee\n\n---\n\nzzzxxx");
  });
});
