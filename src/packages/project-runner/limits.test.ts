const getContainerSwapSizeMb = jest.fn();

jest.mock("@cocalc/backend/podman/memory", () => ({
  getContainerSwapSizeMb: (...args: any[]) => getContainerSwapSizeMb(...args),
}));

describe("podmanLimits memory pressure controls", () => {
  const originalReservationRatio =
    process.env.COCALC_PROJECT_MEMORY_RESERVATION_RATIO;
  const originalHighRatio = process.env.COCALC_PROJECT_MEMORY_HIGH_RATIO;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.COCALC_PROJECT_MEMORY_RESERVATION_RATIO;
    delete process.env.COCALC_PROJECT_MEMORY_HIGH_RATIO;
    getContainerSwapSizeMb.mockResolvedValue(0);
  });

  afterAll(() => {
    if (originalReservationRatio == null) {
      delete process.env.COCALC_PROJECT_MEMORY_RESERVATION_RATIO;
    } else {
      process.env.COCALC_PROJECT_MEMORY_RESERVATION_RATIO =
        originalReservationRatio;
    }
    if (originalHighRatio == null) {
      delete process.env.COCALC_PROJECT_MEMORY_HIGH_RATIO;
    } else {
      process.env.COCALC_PROJECT_MEMORY_HIGH_RATIO = originalHighRatio;
    }
  });

  it("adds a default memory reservation without reclaim throttling", async () => {
    const { podmanLimits } = await import("./run/limits");

    await expect(podmanLimits({ memory: 1000 })).resolves.toEqual([
      "--cpu-shares=1024",
      "--memory=1000",
      "--memory-reservation=800",
    ]);
  });

  it("uses custom memory pressure ratios when configured", async () => {
    process.env.COCALC_PROJECT_MEMORY_RESERVATION_RATIO = "0.5";
    process.env.COCALC_PROJECT_MEMORY_HIGH_RATIO = "0.75";
    const { podmanLimits } = await import("./run/limits");

    await expect(podmanLimits({ memory: 1000 })).resolves.toEqual([
      "--cpu-shares=1024",
      "--memory=1000",
      "--memory-reservation=500",
      "--cgroup-conf=memory.high=750",
    ]);
  });

  it("falls back to a safe reservation ratio when the configured one exceeds memory.high", async () => {
    process.env.COCALC_PROJECT_MEMORY_RESERVATION_RATIO = "0.95";
    process.env.COCALC_PROJECT_MEMORY_HIGH_RATIO = "0.7";
    const { podmanLimits } = await import("./run/limits");

    await expect(podmanLimits({ memory: 1000 })).resolves.toEqual([
      "--cpu-shares=1024",
      "--memory=1000",
      "--memory-reservation=649",
      "--cgroup-conf=memory.high=700",
    ]);
  });

  it("keeps swap support alongside the new soft memory controls", async () => {
    getContainerSwapSizeMb.mockResolvedValue(200);
    const { podmanLimits } = await import("./run/limits");

    await expect(podmanLimits({ memory: 1000, swap: true })).resolves.toEqual([
      "--cpu-shares=1024",
      "--memory=1000",
      "--memory-reservation=800",
      "--memory-swap=1200",
    ]);
  });

  it("adds explicit process and kernel-resource limits", async () => {
    const { podmanLimits } = await import("./run/limits");

    await expect(
      podmanLimits({
        pids: 4096,
        nofile: 8192,
        core: 0,
        shmSize: "64m",
      }),
    ).resolves.toEqual([
      "--cpu-shares=1024",
      "--pids-limit=4096",
      "--ulimit=nofile=8192:8192",
      "--ulimit=core=0:0",
      "--shm-size=64m",
    ]);
  });

  it.each([
    [0, 1024, "39"],
    [1, 2048, "79"],
    [2, 4096, "157"],
    [4, 16384, "625"],
    [99, 262144, "10000"],
  ])(
    "maps CPU priority %p to work-conserving shares %p and cgroup weight %p",
    async (cpu_priority, shares, weight) => {
      const { podmanLimits, projectCgroupLimitsFromPodmanArgs } =
        await import("./run/limits");
      const args = await podmanLimits({ cpu_priority });

      expect(args).toEqual([`--cpu-shares=${shares}`]);
      expect(projectCgroupLimitsFromPodmanArgs(args).cpu_weight).toBe(weight);
      expect(projectCgroupLimitsFromPodmanArgs(args).cpu_max_quota).toBe("max");
    },
  );

  it("does not turn the legacy CoCalc.com CPU limit into a fair-mode cap", async () => {
    const { podmanLimits, projectCgroupLimitsFromPodmanArgs } =
      await import("./run/limits");
    const args = await podmanLimits({ cpu: 1, cpu_priority: 2 });

    expect(args).toEqual(["--cpu-shares=4096"]);
    expect(projectCgroupLimitsFromPodmanArgs(args).cpu_max_quota).toBe("max");
  });

  it("translates Podman limits into cgroup-v2 leaf controls", async () => {
    getContainerSwapSizeMb.mockResolvedValue(200);
    const {
      podmanLimits,
      projectCgroupLimitsFromPodmanArgs,
      withoutPodmanCgroupLimits,
    } = await import("./run/limits");
    const args = await podmanLimits({
      memory: 1000,
      swap: true,
      pids: 4096,
      nofile: 8192,
      shmSize: "64m",
    });

    expect(projectCgroupLimitsFromPodmanArgs(args)).toEqual({
      memory_max: "1000",
      memory_high: "max",
      memory_low: "800",
      memory_swap_max: "200",
      pids_max: "4096",
      cpu_max_quota: "max",
      cpu_max_period: "100000",
      cpu_weight: "39",
      io_weight: "100",
      io_class: "standard",
    });
    expect(withoutPodmanCgroupLimits(args)).toEqual([
      "--ulimit=nofile=8192:8192",
      "--shm-size=64m",
    ]);
  });

  // The root helper writes memory_swap_max to the project leaf on start and on
  // every reconcile (run/podman.ts reconcileProjectCgroup), so this mapping is
  // what a project gets.
  it.each([
    ["a memory limit with swap enabled but no host swap", { memory: 1000, swap: true }, 0],
    ["a memory limit with swap disabled", { memory: 1000, swap: false }, 200],
    ["no memory limit at all", { pids: 4096 }, 200],
  ])(
    "gives no swap to a project with no swap allowance: %s",
    async (_name, config, hostSwap) => {
      getContainerSwapSizeMb.mockResolvedValue(hostSwap);
      const { podmanLimits, projectCgroupLimitsFromPodmanArgs } =
        await import("./run/limits");
      const args = await podmanLimits(config);

      expect(args.some((arg) => arg.startsWith("--memory-swap="))).toBe(false);
      expect(projectCgroupLimitsFromPodmanArgs(args).memory_swap_max).toBe("0");
    },
  );

  it("keeps a computed swap allowance", async () => {
    getContainerSwapSizeMb.mockResolvedValue(300);
    const { podmanLimits, projectCgroupLimitsFromPodmanArgs } =
      await import("./run/limits");

    expect(
      projectCgroupLimitsFromPodmanArgs(
        await podmanLimits({ memory: 1000, swap: true }),
      ).memory_swap_max,
    ).toBe("300");
  });
});
