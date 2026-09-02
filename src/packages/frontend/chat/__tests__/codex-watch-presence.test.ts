/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  __test__,
  isDirectlyWatchingCodexThread,
  registerDirectlyWatchedCodexThread,
} from "../codex-watch-presence";

const WATCH = {
  account_id: "account-1",
  project_id: "project-1",
  path: "agent.chat",
  thread_id: "thread-1",
};

describe("Codex direct-watch presence", () => {
  beforeEach(() => {
    __test__.clear();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => true,
    });
  });

  afterEach(() => __test__.clear());

  it("tracks an actively watched local thread", () => {
    const dispose = registerDirectlyWatchedCodexThread({
      ...WATCH,
      active: true,
    });
    expect(isDirectlyWatchingCodexThread(WATCH)).toBe(true);
    expect(
      isDirectlyWatchingCodexThread({ ...WATCH, account_id: "account-2" }),
    ).toBe(false);
    dispose();
    expect(isDirectlyWatchingCodexThread(WATCH)).toBe(false);
  });

  it("honors a fresh account-scoped lease from another tab", () => {
    __test__.setLastInteractionAt(Date.now() - 120_000);
    __test__.setRemotePresence("other-tab", {
      updated_at: Date.now(),
      watches: [WATCH],
    });
    expect(isDirectlyWatchingCodexThread(WATCH)).toBe(true);
    expect(
      isDirectlyWatchingCodexThread({ ...WATCH, account_id: "account-2" }),
    ).toBe(false);
  });

  it("ignores expired remote leases", () => {
    __test__.setLastInteractionAt(Date.now() - 120_000);
    __test__.setRemotePresence("stale-tab", {
      updated_at: Date.now() - 31_000,
      watches: [WATCH],
    });
    expect(isDirectlyWatchingCodexThread(WATCH)).toBe(false);
  });
});
