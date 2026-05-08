import type { HostFieldOption } from "../providers/registry";
import {
  markRecommendedRegionOption,
  sortRegionOptionsByPreference,
} from "./region-ranking";

function regionOption(
  value: string,
  hourlyRate: number | undefined,
  extraMeta?: Record<string, any>,
): HostFieldOption {
  return {
    value,
    label: value,
    selectionLabel: value,
    meta: {
      compatible: true,
      expectPrice: hourlyRate != null,
      hourlyRate,
      ...extraMeta,
    },
  };
}

describe("region ranking", () => {
  it("prefers nearby regions when preference is closest", () => {
    const options = sortRegionOptionsByPreference({
      options: [
        regionOption("europe-west1", 1.5),
        regionOption("us-west1", 1.0),
      ],
      preference: "closest",
      preferredRegion: "weur",
    });
    expect(options[0].value).toBe("europe-west1");
  });

  it("prefers cheaper regions when preference is cheapest", () => {
    const options = sortRegionOptionsByPreference({
      options: [
        regionOption("europe-west1", 1.5),
        regionOption("us-west1", 1.0),
      ],
      preference: "cheapest",
      preferredRegion: "weur",
    });
    expect(options[0].value).toBe("us-west1");
  });

  it("penalizes price-unavailable regions when a price is expected", () => {
    const options = sortRegionOptionsByPreference({
      options: [
        regionOption("europe-west1", undefined, { expectPrice: true }),
        regionOption("us-west1", 1.2),
      ],
      preference: "balanced",
      preferredRegion: "weur",
    });
    expect(options[0].value).toBe("us-west1");
  });

  it("marks the first option as recommended without changing selection labels", () => {
    const options = markRecommendedRegionOption([
      regionOption("europe-west1", 1.2),
      regionOption("us-west1", 1.0),
    ]);
    expect(options[0].label).toContain("recommended");
    expect(options[0].selectionLabel).toBe("europe-west1");
  });
});
