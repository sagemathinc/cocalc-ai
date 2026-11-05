/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  DEFAULT_NEBIUS_SPOT_HEADROOM_PERCENT,
  nebiusSpotMaxPricePerGpuHour,
  nebiusSpotPolicyName,
  nebiusSpotPriceStopMessage,
  nebiusSpotPriceWithinCap,
  normalizeNebiusSpotHeadroomPercent,
} from "./nebius-spot-pricing";

describe("nebiusSpotMaxPricePerGpuHour", () => {
  it("adds the headroom and rounds up to Nebius's 3 decimals", () => {
    expect(
      nebiusSpotMaxPricePerGpuHour({
        live_price_per_gpu_hour: "2.000",
        headroom_percent: 20,
      }),
    ).toBe("2.400");
    // 2.345 * 1.2 = 2.814 exactly
    expect(
      nebiusSpotMaxPricePerGpuHour({
        live_price_per_gpu_hour: "2.345",
        headroom_percent: 20,
      }),
    ).toBe("2.814");
    // 1.001 * 1.2 = 1.2012 -> 1.202 (never under the headroom)
    expect(
      nebiusSpotMaxPricePerGpuHour({
        live_price_per_gpu_hour: "1.001",
        headroom_percent: 20,
      }),
    ).toBe("1.202");
  });

  it("rounds extra price digits up, so the cap is never under the live price", () => {
    expect(
      nebiusSpotMaxPricePerGpuHour({
        live_price_per_gpu_hour: "0.79001",
        headroom_percent: 0,
      }),
    ).toBe("0.791");
  });

  it("uses the default headroom for a missing or invalid setting", () => {
    for (const headroom of [undefined, null, "", "abc", -5, 1000]) {
      expect(
        nebiusSpotMaxPricePerGpuHour({
          live_price_per_gpu_hour: "1.000",
          headroom_percent: headroom,
        }),
      ).toBe(
        (1 + DEFAULT_NEBIUS_SPOT_HEADROOM_PERCENT / 100).toFixed(3),
      );
    }
    expect(normalizeNebiusSpotHeadroomPercent("35")).toBe(35);
  });

  it("stays 1 cent under on-demand, and refuses when nothing fits", () => {
    expect(
      nebiusSpotMaxPricePerGpuHour({
        live_price_per_gpu_hour: "4.000",
        headroom_percent: 20,
        on_demand_price_per_gpu_hour: "4.500",
      }),
    ).toBe("4.490");
    expect(
      nebiusSpotMaxPricePerGpuHour({
        live_price_per_gpu_hour: "4.495",
        headroom_percent: 20,
        on_demand_price_per_gpu_hour: "4.500",
      }),
    ).toBeUndefined();
    expect(
      nebiusSpotMaxPricePerGpuHour({
        live_price_per_gpu_hour: "1.000",
        headroom_percent: 20,
        on_demand_price_per_gpu_hour: "nope",
      }),
    ).toBeUndefined();
  });

  it("refuses unusable live prices", () => {
    for (const live of [undefined, "", "0", "0.000", "-1", "1e3", "abc"]) {
      expect(
        nebiusSpotMaxPricePerGpuHour({
          live_price_per_gpu_hour: live,
          headroom_percent: 20,
        }),
      ).toBeUndefined();
    }
  });
});

describe("nebiusSpotPolicyName", () => {
  it("names one policy per platform and cap", () => {
    expect(nebiusSpotPolicyName("gpu-h100-sxm", "2.150")).toBe(
      "cocalc-spot-gpu-h100-sxm-2-150",
    );
    expect(nebiusSpotPolicyName("GPU_L40S", "1.000")).toBe(
      "cocalc-spot-gpu-l40s-1-000",
    );
  });

  it("refuses non-canonical prices and empty platforms", () => {
    expect(() => nebiusSpotPolicyName("gpu-h100-sxm", "2.15")).toThrow();
    expect(() => nebiusSpotPolicyName("gpu-h100-sxm", "2.1501")).toThrow();
    expect(() => nebiusSpotPolicyName("", "2.150")).toThrow();
  });
});

describe("nebiusSpotPriceWithinCap", () => {
  it("compares in thousandths, failing closed", () => {
    expect(nebiusSpotPriceWithinCap("2.400", "2.400")).toBe(true);
    expect(nebiusSpotPriceWithinCap("2.4001", "2.400")).toBe(false);
    expect(nebiusSpotPriceWithinCap("2.39", "2.400")).toBe(true);
    expect(nebiusSpotPriceWithinCap(undefined, "2.400")).toBe(false);
    expect(nebiusSpotPriceWithinCap("2.000", undefined)).toBe(false);
  });
});

describe("nebiusSpotPriceStopMessage", () => {
  it("names the cap and the way out", () => {
    const message = nebiusSpotPriceStopMessage("2.400");
    expect(message).toContain("$2.400 per GPU-hour");
    expect(message).toContain("Standard");
  });
});
