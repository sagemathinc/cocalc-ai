/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  classifyStartupPerformancePolicy,
  postSurfaceDelayMs,
} from "./startup-performance-policy";

describe("startup performance policy", () => {
  it("keeps capable clients in full mode", () => {
    expect(
      classifyStartupPerformancePolicy({
        override: "auto",
        signals: {
          deviceMemoryGb: 8,
          downlinkMbps: 20,
          effectiveConnectionType: "4g",
          hardwareConcurrency: 8,
        },
      }),
    ).toMatchObject({ mode: "full", reasons: [] });
  });

  it.each([
    [{ saveData: true }, "save-data"],
    [{ downlinkMbps: 1 }, "downlink"],
    [{ observedTransferMbps: 2 }, "observed-transfer"],
    [{ bootstrapModuleLoadedMs: 2_500 }, "slow-bootstrap"],
    [{ effectiveConnectionType: "2g" }, "connection:2g"],
    [{ hardwareConcurrency: 2 }, "cpu"],
    [{ deviceMemoryGb: 2 }, "memory"],
    [{ smallTouchDevice: true }, "small-touch-device"],
  ])("selects reduced mode for constrained signal %j", (signals, reason) => {
    const policy = classifyStartupPerformancePolicy({
      override: "auto",
      signals,
    });
    expect(policy.mode).toBe("reduced");
    expect(policy.reasons).toContain(reason);
  });

  it("honors explicit browser-local overrides", () => {
    expect(
      classifyStartupPerformancePolicy({
        override: "full",
        signals: { saveData: true },
      }).mode,
    ).toBe("full");
    expect(
      classifyStartupPerformancePolicy({
        override: "reduced",
        signals: {},
      }).mode,
    ).toBe("reduced");
  });

  it("stages only reduced-mode optional work", () => {
    expect(postSurfaceDelayMs("full", "banners")).toBe(0);
    expect(postSurfaceDelayMs("reduced", "navigation")).toBeLessThan(
      postSurfaceDelayMs("reduced", "modals"),
    );
    expect(postSurfaceDelayMs("reduced", "modals")).toBeLessThan(
      postSurfaceDelayMs("reduced", "banners"),
    );
  });
});
