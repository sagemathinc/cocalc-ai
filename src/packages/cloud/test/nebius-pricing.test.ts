import { normalizeNebiusUnitAndPrice } from "../catalog/nebius-pricing";

describe("Nebius pricing docs parser", () => {
  it("converts monthly GiB pricing to hourly GiB pricing", () => {
    expect(
      normalizeNebiusUnitAndPrice({
        price: "0.11761103",
        unit: "Price per 1 GiB per 730 hours",
      }),
    ).toEqual({
      price: String(0.11761103 / 730),
      unit: "GiB hour",
    });
  });
});
