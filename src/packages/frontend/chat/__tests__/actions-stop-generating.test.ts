/** @jest-environment jsdom */

import { shouldOptimisticallyStopGeneratingLocally } from "../actions";

describe("shouldOptimisticallyStopGeneratingLocally", () => {
  it("keeps Codex turns live until the backend confirms the interrupt", () => {
    expect(
      shouldOptimisticallyStopGeneratingLocally({ threadId: "session-123" }),
    ).toBe(false);
  });

  it("still allows optimistic stop for legacy non-ACP turns", () => {
    expect(shouldOptimisticallyStopGeneratingLocally({})).toBe(true);
    expect(shouldOptimisticallyStopGeneratingLocally()).toBe(true);
  });
});
