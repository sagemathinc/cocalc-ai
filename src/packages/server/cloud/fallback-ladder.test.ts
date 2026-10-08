import {
  allowedRecoveryFamilies,
  alternateMachineTypes,
  buildFallbackLadder,
  classifyStartFailure,
  exhaustedLadderRetryDelayMs,
  isCoreEquivalent,
  machineShape,
  quotaMetricForRung,
  rungFitsQuota,
} from "./fallback-ladder";

describe("classifyStartFailure", () => {
  it.each([
    [
      "Error: QUOTA_EXCEEDED: Quota 'T2D_CPUS' exceeded.  Limit: 24.0 in region asia-south2.",
      "quota",
    ],
    ["ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS: no capacity", "capacity"],
    ["The zone does not have enough resources available", "capacity"],
    ["Instance requires gVNIC for machine type c3d-highcpu-30", "incompatible"],
    ["Invalid value for field 'resource.machineType': 'x'", "incompatible"],
    ["socket hang up", "transient"],
    ["RESOURCE_NOT_READY: fingerprint race", "transient"],
  ])("%s -> %s", (message, kind) => {
    expect(classifyStartFailure(new Error(message))).toBe(kind);
  });
});

describe("core-equivalent machine shapes", () => {
  const t2d16 = machineShape({
    name: "t2d-standard-16",
    guestCpus: 16,
    memoryMb: 65536,
  })!;

  it("counts physical cores, not vCPUs", () => {
    expect(t2d16.cores).toBe(16);
    expect(
      machineShape({ name: "n2d-standard-16", guestCpus: 16, memoryMb: 65536 })
        ?.cores,
    ).toBe(8);
    expect(
      machineShape({
        name: "e2-micro",
        guestCpus: 2,
        memoryMb: 1024,
        isSharedCpu: true,
      }),
    ).toBeUndefined();
  });

  it("accepts the same cores and memory within 10%, not half or triple", () => {
    const shape = (name: string, guestCpus: number, gb: number) =>
      machineShape({ name, guestCpus, memoryMb: gb * 1024 })!;
    expect(isCoreEquivalent(t2d16, shape("c2d-highcpu-32", 32, 64))).toBe(true);
    expect(isCoreEquivalent(t2d16, shape("c3d-highcpu-30", 30, 59))).toBe(true);
    expect(isCoreEquivalent(t2d16, shape("n2d-standard-32", 32, 128))).toBe(
      true,
    );
    expect(isCoreEquivalent(t2d16, shape("n2d-standard-16", 16, 64))).toBe(
      false,
    );
    expect(isCoreEquivalent(t2d16, shape("n2d-standard-64", 64, 256))).toBe(
      false,
    );
  });

  it("ranks by catalog price, one per family, unpriced last, NIC-aware", () => {
    const available = [
      { name: "t2d-standard-16", guestCpus: 16, memoryMb: 65536 },
      { name: "n2d-standard-32", guestCpus: 32, memoryMb: 131072 },
      { name: "n2d-highmem-32", guestCpus: 32, memoryMb: 262144 },
      { name: "n2-standard-32", guestCpus: 32, memoryMb: 131072 },
      { name: "c2d-highcpu-32", guestCpus: 32, memoryMb: 65536 },
      { name: "c3d-highcpu-30", guestCpus: 30, memoryMb: 60416 },
    ];
    const r = (value: number) => ({ "us-south1": value });
    const prices: any = {
      families: {
        n2d: {
          cpu: r(0.03),
          ram: r(0.004),
          spot_cpu: r(0.012),
          spot_ram: r(0.0016),
        },
        n2: {
          cpu: r(0.035),
          ram: r(0.005),
          spot_cpu: r(0.006),
          spot_ram: r(0.0008),
        },
        c3d: {
          cpu: r(0.04),
          ram: r(0.005),
          spot_cpu: r(0.003),
          spot_ram: r(0.0004),
        },
      },
    };
    const pick = (gvnic: boolean, pricing: "spot" | "on_demand") =>
      alternateMachineTypes({
        desired: t2d16,
        available,
        families: allowedRecoveryFamilies({ gvnic }),
        prices,
        region: "us-south1",
        pricing,
      }).map(({ machine_type }) => machine_type);
    // Virtio NIC: no C3D even though it is cheapest.
    expect(pick(false, "spot")).toEqual([
      "n2-standard-32",
      "n2d-standard-32",
      "c2d-highcpu-32",
    ]);
    expect(pick(true, "spot")[0]).toBe("c3d-highcpu-30");
    expect(pick(false, "on_demand")).toEqual([
      "n2d-standard-32",
      "n2-standard-32",
      "c2d-highcpu-32",
    ]);
  });
});

describe("buildFallbackLadder", () => {
  it("orders Spot desired, standard desired, Spot alternates, standard alternates", () => {
    expect(
      buildFallbackLadder({
        desired_machine_type: "t2d-standard-16",
        spot_alternates: ["n2d-standard-32", "n2d-standard-32"],
        standard_alternates: ["n2d-standard-32"],
        tried: ["spot:t2d-standard-16"],
      }),
    ).toEqual([
      { pricing: "on_demand", machine_type: "t2d-standard-16" },
      { pricing: "spot", machine_type: "n2d-standard-32" },
      { pricing: "on_demand", machine_type: "n2d-standard-32" },
    ]);
  });

  it("maps rungs to the regional quota they consume", () => {
    expect(
      quotaMetricForRung({ pricing: "spot", machine_type: "t2d-standard-16" }),
    ).toBe("PREEMPTIBLE_CPUS");
    expect(
      quotaMetricForRung({
        pricing: "on_demand",
        machine_type: "n2d-standard-32",
      }),
    ).toBe("N2D_CPUS");
    const rung = {
      pricing: "on_demand" as const,
      machine_type: "t2d-standard-16",
    };
    expect(rungFitsQuota({ rung, vcpus: 16, headroom: { T2D_CPUS: 8 } })).toBe(
      false,
    );
    expect(rungFitsQuota({ rung, vcpus: 16, headroom: { T2D_CPUS: 24 } })).toBe(
      true,
    );
    // Unknown quota: let the provider decide.
    expect(rungFitsQuota({ rung, vcpus: 16, headroom: {} })).toBe(true);
    expect(rungFitsQuota({ rung, vcpus: 16 })).toBe(true);
  });

  it("backs off exhausted passes to at most 10 minutes", () => {
    expect([1, 2, 3, 4, 9].map(exhaustedLadderRetryDelayMs)).toEqual(
      [2, 4, 8, 10, 10].map((m) => m * 60_000),
    );
  });
});
