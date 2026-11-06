/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  assertNebiusSpotFundingAllowed,
  NEBIUS_SPOT_COURSE_MESSAGE,
  NEBIUS_SPOT_NOT_CHEAPER_MESSAGE,
  nebiusOnDemandPricePerGpuHour,
  nebiusSpotRunningRate,
} from "./nebius-spot";

jest.mock("./provider", () => ({
  quoteNebiusComputeSpotPrice: jest.fn(async () => {
    throw new Error("tests inject the quote");
  }),
}));

function rate(hourly: number, components: Array<[string, number, string[]]>) {
  return {
    hourly_cost_usd: hourly.toFixed(6),
    pricing_snapshot: {
      version: 1,
      billing_state: "running",
      hourly_cost_usd: hourly.toFixed(6),
      components: components.map(([key, usd, billing_states]) => ({
        key,
        label: key,
        hourly_cost_usd: usd.toFixed(6),
        billing_states,
      })),
      configuration: {},
    },
  } as any;
}

// 1 GPU on-demand at $4.50 (provider) with a 10% surcharge, plus a disk
const onDemand = rate(4.95 + 0.011, [
  ["gpu", 4.95, ["running"]],
  ["disk", 0.011, ["running", "stopped"]],
]);
const settings = {
  project_hosts_nebius_surcharge_percent: 10,
  nebius_spot_headroom_percent: 20,
};
const rateInput = {
  provider: "nebius",
  region: "eu-north1",
  machine_type: "1gpu-16vcpu-200gb",
  provider_platform: "gpu-h100-sxm",
  gpu_type: "h100",
  gpu_count: 1,
  disk_gb: 100,
  disk_type: "ssd",
} as const;

function quote(price: string) {
  return jest.fn(async () => ({
    region: "eu-north1",
    platform: "gpu-h100-sxm",
    price_per_gpu_hour: price,
    quoted_at: "2026-11-05T12:00:00.000Z",
  }));
}

describe("nebiusSpotRunningRate", () => {
  it("caps at the live price plus headroom and bills that fixed rate", async () => {
    const estimate = jest.fn(async (input: any) =>
      rate(Number(input.nebius_spot_max_price_per_gpu_hour) * 1.1 + 0.011, [
        [
          "gpu",
          Number(input.nebius_spot_max_price_per_gpu_hour) * 1.1,
          ["running"],
        ],
        ["disk", 0.011, ["running", "stopped"]],
      ]),
    );
    const q = quote("2.000");
    const priced = await nebiusSpotRunningRate({
      rate_input: rateInput,
      on_demand_rate: onDemand,
      settings,
      quote: q,
      estimate: estimate as any,
    });
    expect(q).toHaveBeenCalledWith({
      region: "eu-north1",
      platform: "gpu-h100-sxm",
    });
    expect(estimate).toHaveBeenCalledWith(
      expect.objectContaining({
        pricing_model: "spot",
        billing_state: "running",
        nebius_spot_max_price_per_gpu_hour: "2.400",
      }),
    );
    expect(priced.spot).toEqual({
      max_price_per_gpu_hour: "2.400",
      quoted_price_per_gpu_hour: "2.000",
      quoted_at: "2026-11-05T12:00:00.000Z",
      headroom_percent: 20,
      region: "eu-north1",
      platform: "gpu-h100-sxm",
    });
    expect(Number(priced.rate.hourly_cost_usd)).toBeCloseTo(
      2.4 * 1.1 + 0.011,
      6,
    );
  });

  it("keeps the cap 1 cent under on-demand", async () => {
    const estimate = jest.fn(async (input: any) =>
      rate(Number(input.nebius_spot_max_price_per_gpu_hour), [
        ["gpu", Number(input.nebius_spot_max_price_per_gpu_hour), ["running"]],
      ]),
    );
    const priced = await nebiusSpotRunningRate({
      rate_input: rateInput,
      on_demand_rate: onDemand,
      settings,
      quote: quote("4.000"),
      estimate: estimate as any,
    });
    expect(priced.spot.max_price_per_gpu_hour).toBe("4.490");
  });

  it("refuses Spot when no cap fits under on-demand, or the rate isn't cheaper", async () => {
    await expect(
      nebiusSpotRunningRate({
        rate_input: rateInput,
        on_demand_rate: onDemand,
        settings,
        quote: quote("4.499"),
        estimate: jest.fn() as any,
      }),
    ).rejects.toThrow(NEBIUS_SPOT_NOT_CHEAPER_MESSAGE);
    await expect(
      nebiusSpotRunningRate({
        rate_input: rateInput,
        on_demand_rate: onDemand,
        settings,
        quote: quote("2.000"),
        // e.g. a Windows license makes the capped rate exceed Standard
        estimate: jest.fn(async () =>
          rate(99, [["gpu", 99, ["running"]]]),
        ) as any,
      }),
    ).rejects.toThrow(NEBIUS_SPOT_NOT_CHEAPER_MESSAGE);
  });

  it("refuses non-GPU machines and a missing quote", async () => {
    await expect(
      nebiusSpotRunningRate({
        rate_input: { ...rateInput, gpu_count: 0 },
        on_demand_rate: onDemand,
        settings,
        quote: quote("2.000"),
      }),
    ).rejects.toThrow(/GPU machines only/);
    await expect(
      nebiusSpotRunningRate({
        rate_input: rateInput,
        on_demand_rate: onDemand,
        settings,
        quote: jest.fn(async () => {
          throw new Error("Nebius Spot price is unavailable right now");
        }) as any,
      }),
    ).rejects.toThrow(/unavailable/);
  });
});

describe("nebiusOnDemandPricePerGpuHour", () => {
  it("uses running-only compute components, without the surcharge", () => {
    const withLicense = rate(10, [
      ["vm", 1.1, ["running"]],
      ["gpu", 8.8, ["running"]],
      ["windows_license", 0.5, ["running"]],
      ["disk", 0.2, ["running", "stopped"]],
    ]);
    expect(nebiusOnDemandPricePerGpuHour(withLicense, 0.1, 2)).toBe("4.500000");
    expect(nebiusOnDemandPricePerGpuHour(withLicense, 0.1, 0)).toBeUndefined();
  });
});

describe("assertNebiusSpotFundingAllowed", () => {
  it("refuses Nebius Spot for course-sponsored compute only", () => {
    expect(() =>
      assertNebiusSpotFundingAllowed({
        provider: "nebius",
        pricing_model: "spot",
        course_funded: true,
      }),
    ).toThrow(NEBIUS_SPOT_COURSE_MESSAGE);
    for (const opts of [
      { provider: "nebius", pricing_model: "on_demand", course_funded: true },
      { provider: "nebius", pricing_model: "spot", course_funded: false },
      { provider: "gcp", pricing_model: "spot", course_funded: true },
    ]) {
      expect(() => assertNebiusSpotFundingAllowed(opts)).not.toThrow();
    }
  });
});
