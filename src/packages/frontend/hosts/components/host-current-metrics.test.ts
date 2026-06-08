import type { Host } from "@cocalc/conat/hub/api/hosts";

import {
  getSharedScratchUsedBytes,
  getSharedScratchUsedPercent,
  hasSharedScratchConfigured,
} from "./host-current-metrics";

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
    expect(
      hasSharedScratchConfigured({
        id: "host-1",
        name: "Host",
        owner: "account-1",
        region: "us",
        size: "custom",
        gpu: false,
        status: "running",
        machine: { shared_disk_gb: 500 },
      } as Host),
    ).toBe(true);
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
});
