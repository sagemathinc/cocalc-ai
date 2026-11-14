import {
  allowedRecoveryFamilies,
  alternateMachineTypes,
  buildFallbackLadder,
  classifyStartFailure,
  customMachineType,
  customMachineVcpus,
  exhaustedLadderRetryDelayMs,
  isCoreEquivalent,
  isCustomMachineType,
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
    expect(isCoreEquivalent(t2d16, shape("n2d-custom-32-65536", 32, 64))).toBe(
      true,
    );
    // Twice the memory: the host's RAM would change on fallback (and cost
    // more), so a 64 GB host no longer falls back to a 128 GB type.
    expect(isCoreEquivalent(t2d16, shape("n2d-standard-32", 32, 128))).toBe(
      false,
    );
    expect(isCoreEquivalent(t2d16, shape("n2-standard-32", 32, 128))).toBe(
      false,
    );
    expect(isCoreEquivalent(t2d16, shape("x-standard-32", 32, 70))).toBe(true);
    expect(isCoreEquivalent(t2d16, shape("x-standard-32", 32, 71))).toBe(false);
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
    // Virtio NIC: no C3D even though it is cheapest. N2 and N2D have no
    // predefined 16-core 64 GB type, so they come as custom types.
    expect(pick(false, "spot")).toEqual([
      "n2-custom-32-65536",
      "n2d-custom-32-65536",
      "c2d-highcpu-32",
    ]);
    expect(pick(true, "spot")[0]).toBe("c3d-highcpu-30");
    expect(pick(false, "on_demand")).toEqual([
      "n2d-custom-32-65536",
      "n2-custom-32-65536",
      "c2d-highcpu-32",
    ]);
    // Custom types carry GCP's 5% premium.
    expect(
      alternateMachineTypes({
        desired: t2d16,
        available,
        families: ["n2d"],
        prices,
        region: "us-south1",
        pricing: "on_demand",
      }),
    ).toEqual([
      {
        machine_type: "n2d-custom-32-65536",
        usd_per_hour: expect.closeTo((32 * 0.03 + 64 * 0.004) * 1.05, 10),
      },
    ]);
  });

  it("offers custom types only for families the zone has", () => {
    expect(
      alternateMachineTypes({
        desired: t2d16,
        available: [
          { name: "t2d-standard-16", guestCpus: 16, memoryMb: 65536 },
          { name: "c2d-highcpu-32", guestCpus: 32, memoryMb: 65536 },
        ],
        families: allowedRecoveryFamilies({ gvnic: false }),
        region: "us-south1",
        pricing: "spot",
      }).map(({ machine_type }) => machine_type),
    ).toEqual(["c2d-highcpu-32"]);
  });
});

describe("customMachineType", () => {
  const desired = (cores: number, memory_gb: number) => ({ cores, memory_gb });

  it("matches the desired physical cores and memory", () => {
    expect(customMachineType("n2d", desired(16, 64))).toEqual({
      name: "n2d-custom-32-65536",
      guestCpus: 32,
      memoryMb: 65536,
    });
    expect(customMachineType("n2", desired(8, 32))?.name).toBe(
      "n2-custom-16-32768",
    );
    // Rounded to GCP's 256 MiB memory step.
    expect(customMachineType("n2", desired(2, 15.9))?.name).toBe(
      "n2-custom-4-16384",
    );
  });

  it("only produces vCPU counts the series allows", () => {
    // N2: even counts up to 32, then multiples of 4 up to 80.
    expect(customMachineType("n2", desired(16, 64))?.name).toBe(
      "n2-custom-32-65536",
    );
    expect(customMachineType("n2", desired(17, 68))).toBeUndefined();
    expect(customMachineType("n2", desired(18, 72))?.name).toBe(
      "n2-custom-36-73728",
    );
    expect(customMachineType("n2", desired(40, 160))?.name).toBe(
      "n2-custom-80-163840",
    );
    expect(customMachineType("n2", desired(42, 168))).toBeUndefined();
    // N2D: 2, 4, 8, 16, 32, 48, 64, 80 or 96 vCPUs.
    expect(customMachineType("n2d", desired(24, 96))?.name).toBe(
      "n2d-custom-48-98304",
    );
    expect(customMachineType("n2d", desired(6, 24))).toBeUndefined();
    expect(customMachineType("n2d", desired(48, 192))?.name).toBe(
      "n2d-custom-96-196608",
    );
    expect(customMachineType("n2d", desired(50, 200))).toBeUndefined();
    expect(customMachineType("n2", desired(1.5, 8))).toBeUndefined();
  });

  it("keeps memory within 0.5-8 GB per vCPU", () => {
    expect(customMachineType("n2d", desired(16, 256))?.name).toBe(
      "n2d-custom-32-262144",
    );
    expect(customMachineType("n2d", desired(16, 257))).toBeUndefined();
    expect(customMachineType("n2d", desired(16, 16))?.name).toBe(
      "n2d-custom-32-16384",
    );
    expect(customMachineType("n2d", desired(16, 15))).toBeUndefined();
  });

  it("has no custom types for other families", () => {
    for (const family of ["t2d", "c2d", "c3d", "c3", "e2"]) {
      expect(customMachineType(family, desired(16, 64))).toBeUndefined();
    }
  });

  it("names parse back to their vCPUs", () => {
    expect(customMachineVcpus("n2d-custom-32-65536")).toBe(32);
    expect(customMachineVcpus("n2-custom-8-32768-ext")).toBe(8);
    expect(customMachineVcpus("n2d-standard-32")).toBeUndefined();
    expect(isCustomMachineType("n2-custom-36-73728")).toBe(true);
    expect(isCustomMachineType("t2d-standard-16")).toBe(false);
  });
});

describe("buildFallbackLadder", () => {
  it("orders Spot desired, Spot alternates, standard desired, standard alternates", () => {
    expect(
      buildFallbackLadder({
        desired_machine_type: "t2d-standard-16",
        spot_alternates: ["n2d-standard-32", "n2d-standard-32"],
        standard_alternates: ["n2d-standard-32"],
        tried: ["spot:t2d-standard-16"],
      }),
    ).toEqual([
      { pricing: "spot", machine_type: "n2d-standard-32" },
      { pricing: "on_demand", machine_type: "t2d-standard-16" },
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
