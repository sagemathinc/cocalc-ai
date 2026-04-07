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

  it("adds default memory reservation and memory.high below the hard limit", async () => {
    const { podmanLimits } = await import("./run/limits");

    await expect(podmanLimits({ memory: 1000 })).resolves.toEqual([
      "--cpu-shares=1024",
      "--memory=1000",
      "--memory-reservation=800",
      "--cgroup-conf=memory.high=900",
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
      "--cgroup-conf=memory.high=900",
      "--memory-swap=1200",
    ]);
  });
});
