import { getHourlyRateUsd } from "../catalog/gcp-pricing";

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
});
