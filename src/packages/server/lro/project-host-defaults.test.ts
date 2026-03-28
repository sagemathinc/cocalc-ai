import {
  inferProjectHostCpuCount,
  recommendedProjectHostParallelism,
} from "./project-host-defaults";

describe("project-host default parallelism", () => {
  it("derives a conservative per-host parallelism from cpu count", () => {
    expect(recommendedProjectHostParallelism(1)).toBe(1);
    expect(recommendedProjectHostParallelism(4)).toBe(2);
    expect(recommendedProjectHostParallelism(16)).toBe(8);
    expect(recommendedProjectHostParallelism(128)).toBe(32);
  });

  it("infers cpu count from common project-host metadata shapes", () => {
    expect(
      inferProjectHostCpuCount({
        metadata: { size: "t2d-standard-16" },
      }),
    ).toBe(16);

    expect(
      inferProjectHostCpuCount({
        metadata: {
          machine: { machine_type: "n2-highmem-4" },
        },
      }),
    ).toBe(4);

    expect(
      inferProjectHostCpuCount({
        metadata: {
          runtime: {
            metadata: {
              machine_type: "zones/us-west1-a/machineTypes/t2d-standard-16",
            },
          },
        },
      }),
    ).toBe(16);

    expect(
      inferProjectHostCpuCount({
        metadata: { size: "medium" },
      }),
    ).toBe(4);

    expect(
      inferProjectHostCpuCount({
        metadata: {
          machine: { metadata: { vcpus: 12 } },
        },
      }),
    ).toBe(12);
  });
});
