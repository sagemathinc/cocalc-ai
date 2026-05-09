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

  it("normalizes E2, N2, and G2 family SKU rows", () => {
    const catalog = normalizeGcpBillingSkus([
      {
        description: "E2 Instance Core running in Oregon",
        serviceRegions: ["us-west1"],
        category: { usageType: "OnDemand" },
        pricingInfo: [
          {
            pricingExpression: {
              usageUnit: "h",
              tieredRates: [
                {
                  startUsageAmount: 0,
                  unitPrice: { units: "0", nanos: 21000000 },
                },
              ],
            },
          },
        ],
      },
      {
        description: "N2 Instance Ram running in Oregon",
        serviceRegions: ["us-west1"],
        category: { usageType: "OnDemand" },
        pricingInfo: [
          {
            pricingExpression: {
              usageUnit: "GiBy.h",
              tieredRates: [
                {
                  startUsageAmount: 0,
                  unitPrice: { units: "0", nanos: 7000000 },
                },
              ],
            },
          },
        ],
      },
      {
        description: "G2 Instance Core running in Oregon",
        serviceRegions: ["us-west1"],
        category: { usageType: "OnDemand" },
        pricingInfo: [
          {
            pricingExpression: {
              usageUnit: "h",
              tieredRates: [
                {
                  startUsageAmount: 0,
                  unitPrice: { units: "0", nanos: 40000000 },
                },
              ],
            },
          },
        ],
      },
      {
        description: "G2 Instance Ram running in Oregon",
        serviceRegions: ["us-west1"],
        category: { usageType: "OnDemand" },
        pricingInfo: [
          {
            pricingExpression: {
              usageUnit: "GiBy.h",
              tieredRates: [
                {
                  startUsageAmount: 0,
                  unitPrice: { units: "0", nanos: 5000000 },
                },
              ],
            },
          },
        ],
      },
    ]);

    expect(catalog.families.e2?.cpu["us-west1"]).toBeCloseTo(0.021, 9);
    expect(catalog.families.n2?.ram["us-west1"]).toBeCloseTo(0.007, 9);
    expect(catalog.families.g2?.cpu["us-west1"]).toBeCloseTo(0.04, 9);
    expect(catalog.families.g2?.ram["us-west1"]).toBeCloseTo(0.005, 9);
  });
});
