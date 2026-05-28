import { PROVIDERS } from "../registry";

describe("cloud registry", () => {
  it("advertises Hyperstack stop support", () => {
    expect(PROVIDERS.hyperstack?.capabilities.supportsStop).toBe(true);
  });

  it("advertises shared scratch disk support only for implemented providers", () => {
    expect(PROVIDERS.gcp?.capabilities.sharedScratchDisk).toMatchObject({
      supported: true,
      growable: true,
    });
    expect(
      PROVIDERS.gcp?.capabilities.sharedScratchDisk?.disk_types.find(
        (entry) => entry.value === "balanced",
      )?.durability,
    ).toBe("replicated");
    expect(PROVIDERS.nebius?.capabilities.sharedScratchDisk).toMatchObject({
      supported: true,
      growable: true,
    });
    expect(
      PROVIDERS.nebius?.capabilities.sharedScratchDisk?.disk_types.find(
        (entry) => entry.value === "balanced",
      )?.durability,
    ).toBe("single-copy");
    expect(PROVIDERS.lambda?.capabilities.sharedScratchDisk).toBeUndefined();
  });
});
