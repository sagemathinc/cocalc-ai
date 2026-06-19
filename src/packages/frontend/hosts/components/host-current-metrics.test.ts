import type { Host } from "@cocalc/conat/hub/api/hosts";

import {
  formatBytesDense,
  getConfiguredSharedScratchTotalBytes,
  getMetadataDisplayTone,
  getSharedScratchUsedBytes,
  getSharedScratchUsedPercent,
  getSharedScratchTotalBytes,
  hasSharedScratchConfigured,
} from "./host-current-metrics";

describe("host current metrics dense formatting", () => {
  it("uses short binary units without spaces in dense resource rows", () => {
    expect(formatBytesDense(10 * 1024 ** 3)).toBe("10G");
    expect(formatBytesDense(2 * 1024 ** 4)).toBe("2T");
  });
});

describe("host current metrics btrfs metadata display", () => {
  it("uses derived metadata risk instead of raw allocated metadata percent", () => {
    expect(
      getMetadataDisplayTone({
        metadataPercent: 95,
        derived: {
          window_minutes: 60,
          disk: { level: "healthy" },
          metadata: { level: "healthy", used_percent: 95 },
          alerts: [],
          admission_allowed: true,
          auto_grow_recommended: false,
        },
      }),
    ).toBe("green");
  });

  it("falls back to raw metadata percent when derived risk is unavailable", () => {
    expect(getMetadataDisplayTone({ metadataPercent: 95 })).toBe("red");
  });
});

describe("host current metrics scratch helpers", () => {
  it("uses explicit shared scratch used bytes when present", () => {
    expect(
      getSharedScratchUsedBytes({
        shared_scratch_total_bytes: 1000,
        shared_scratch_used_bytes: 250,
        shared_scratch_available_bytes: 100,
      }),
    ).toBe(250);
  });

  it("derives shared scratch used bytes from total minus available", () => {
    expect(
      getSharedScratchUsedBytes({
        shared_scratch_total_bytes: 1000,
        shared_scratch_available_bytes: 125,
      }),
    ).toBe(875);
  });

  it("prefers sampled shared scratch percent and clamps it", () => {
    expect(
      getSharedScratchUsedPercent({
        shared_scratch_total_bytes: 1000,
        shared_scratch_used_bytes: 250,
        shared_scratch_used_percent: 125,
      }),
    ).toBe(100);
  });

  it("computes shared scratch percent from bytes when needed", () => {
    expect(
      getSharedScratchUsedPercent({
        shared_scratch_total_bytes: 1000,
        shared_scratch_used_bytes: 250,
      }),
    ).toBe(25);
  });

  it("detects configured shared scratch from host machine metadata", () => {
    const host = {
      id: "host-1",
      name: "Host",
      owner: "account-1",
      region: "us",
      size: "custom",
      gpu: false,
      status: "running",
      machine: { shared_disk_gb: 500 },
    } as Host;
    expect(hasSharedScratchConfigured(host)).toBe(true);
    expect(getConfiguredSharedScratchTotalBytes(host)).toBe(500 * 1024 ** 3);
    expect(getSharedScratchTotalBytes(host, undefined)).toBe(500 * 1024 ** 3);
    expect(
      hasSharedScratchConfigured({
        id: "host-1",
        name: "Host",
        owner: "account-1",
        region: "us",
        size: "custom",
        gpu: false,
        status: "running",
      } as Host),
    ).toBe(false);
  });

  it("prefers sampled shared scratch total over configured capacity", () => {
    expect(
      getSharedScratchTotalBytes(
        {
          id: "host-1",
          name: "Host",
          owner: "account-1",
          region: "us",
          size: "custom",
          gpu: false,
          status: "running",
          machine: { shared_disk_gb: 500 },
        } as Host,
        { shared_scratch_total_bytes: 750 * 1024 ** 3 },
      ),
    ).toBe(750 * 1024 ** 3);
  });
});
