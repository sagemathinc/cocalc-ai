import {
  getHourlyRateUsd,
  normalizeGcpBillingSkus,
} from "../catalog/gcp-pricing";

describe("GCP billing catalog pricing", () => {
  it("converts monthly GiB disk prices to hourly GiB prices", () => {
    const hourly = getHourlyRateUsd({
      pricingInfo: [
        {
          pricingExpression: {
            usageUnit: "GiBy.mo",
            baseUnit: "By.s",
            baseUnitConversionFactor: 2875910101401600,
            tieredRates: [
              {
                startUsageAmount: 0,
                unitPrice: { units: "0", nanos: 80000000 },
              },
            ],
          },
        },
      ],
    });

    expect(hourly).toBeCloseTo(
      (0.08 * 1024 ** 3 * 3600) / 2875910101401600,
      12,
    );
  });

  it("ignores zero-priced standard PD catalog rows", () => {
    const catalog = normalizeGcpBillingSkus([
      {
        description: "Storage PD Capacity in Oregon",
        serviceRegions: ["us-west1"],
        category: { usageType: "OnDemand" },
        pricingInfo: [
          {
            effectiveTime: "2026-05-09T00:00:00Z",
            pricingExpression: {
              usageUnit: "GiBy.mo",
              baseUnit: "By.s",
              baseUnitConversionFactor: 2875910101401600,
              tieredRates: [
                {
                  startUsageAmount: 0,
                  unitPrice: { units: "0", nanos: 35000000 },
                },
              ],
            },
          },
        ],
      },
      {
        description: "Storage PD Capacity in Oregon",
        serviceRegions: ["us-west1"],
        category: { usageType: "OnDemand" },
        pricingInfo: [
          {
            effectiveTime: "2026-05-09T00:00:00Z",
            pricingExpression: {
              usageUnit: "GiBy.mo",
              baseUnit: "By.s",
              baseUnitConversionFactor: 2875910101401600,
              tieredRates: [
                {
                  startUsageAmount: 0,
                  unitPrice: { units: "0", nanos: 0 },
                },
              ],
            },
          },
        ],
      },
    ]);

    expect(catalog.disks["pd-standard"]?.["us-west1"]).toBeGreaterThan(0);
  });
});
