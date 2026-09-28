/*
 *  This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { renderHook } from "@testing-library/react";
import {
  hasForegroundProjectRuntimeView,
  registerForegroundProjectRuntimeView,
  shouldAutoRestartAfterRuntimeLoss,
} from "./runtime-recovery";
import { useRuntimeRecoveryView } from "./use-runtime-recovery-view";

describe("foreground runtime recovery views", () => {
  it("includes the selected agent's project but not retained hidden agents", () => {
    const { rerender, unmount } = renderHook(
      ({ selected }) => {
        useRuntimeRecoveryView("agent-project-a", selected === "a");
        useRuntimeRecoveryView("agent-project-b", selected === "b");
      },
      { initialProps: { selected: "a" } },
    );
    const shouldRestart = (projectId: string, browserVisible = true) =>
      shouldAutoRestartAfterRuntimeLoss({
        runtimeExitReason: "host_pressure",
        projectVisible: hasForegroundProjectRuntimeView(projectId),
        browserVisible,
      });
    expect(shouldRestart("agent-project-a")).toBe(true);
    expect(shouldRestart("agent-project-a", false)).toBe(false);
    expect(shouldRestart("agent-project-b")).toBe(false);
    rerender({ selected: "b" });
    expect(shouldRestart("agent-project-a")).toBe(false);
    expect(shouldRestart("agent-project-b")).toBe(true);
    rerender({ selected: "none" });
    expect(shouldRestart("agent-project-a")).toBe(false);
    expect(shouldRestart("agent-project-b")).toBe(false);
    unmount();
  });

  it("removes eligibility on unmount or when the viewed project changes", () => {
    const { rerender, unmount } = renderHook(
      ({ projectId }) => useRuntimeRecoveryView(projectId, true),
      { initialProps: { projectId: "old-project" } },
    );
    expect(hasForegroundProjectRuntimeView("old-project")).toBe(true);
    rerender({ projectId: "new-project" });
    expect(hasForegroundProjectRuntimeView("old-project")).toBe(false);
    expect(hasForegroundProjectRuntimeView("new-project")).toBe(true);
    unmount();
    expect(hasForegroundProjectRuntimeView("new-project")).toBe(false);
  });

  it("cleans up each view independently and idempotently", () => {
    const closeFirst = registerForegroundProjectRuntimeView("shared-project");
    const closeSecond = registerForegroundProjectRuntimeView("shared-project");
    closeFirst();
    closeFirst();
    expect(hasForegroundProjectRuntimeView("shared-project")).toBe(true);
    closeSecond();
    expect(hasForegroundProjectRuntimeView("shared-project")).toBe(false);
    const closeReplacement =
      registerForegroundProjectRuntimeView("shared-project");
    closeSecond();
    expect(hasForegroundProjectRuntimeView("shared-project")).toBe(true);
    closeReplacement();
    expect(hasForegroundProjectRuntimeView("shared-project")).toBe(false);
  });
});
