import { classifyInPlaceMachineChange } from "../gcp-machine-change";

const base = {
  currentMachineType: "t2d-standard-8",
  targetMachineType: "t2d-standard-16",
  currentAccelerators: [],
  targetAccelerators: [],
  diskTypes: ["pd-balanced", "pd-balanced"],
};

describe("classifyInPlaceMachineChange", () => {
  it("allows first/second generation x86 changes on Persistent Disk", () => {
    for (const [from, to] of [
      ["t2d-standard-8", "t2d-standard-16"],
      ["t2d-standard-16", "n2d-standard-16"],
      ["n2d-standard-8", "n2-custom-8-32768"],
      ["e2-standard-4", "c2d-standard-8"],
      ["n2-highmem-32", "m1-ultramem-40"],
      ["m1-megamem-96", "m2-ultramem-208"],
    ]) {
      expect(
        classifyInPlaceMachineChange({
          ...base,
          currentMachineType: from,
          targetMachineType: to,
        }),
      ).toEqual({ ok: true });
    }
  });

  it("needs a new instance for later generations, Arm, accelerator-optimized and bare metal", () => {
    for (const to of [
      "c3-standard-8",
      "c3d-standard-8",
      "n4-standard-8",
      "c4-standard-8",
      "c4d-standard-8",
      "t2a-standard-8",
      "a2-highgpu-1g",
      "g2-standard-8",
      "c3-standard-192-metal",
    ]) {
      const verdict = classifyInPlaceMachineChange({
        ...base,
        targetMachineType: to,
      });
      expect(verdict.ok).toBe(false);
    }
    expect(
      classifyInPlaceMachineChange({
        ...base,
        currentMachineType: "g2-standard-8",
        targetMachineType: "g2-standard-16",
      }).ok,
    ).toBe(false);
  });

  it("needs a new instance with Local SSD or non-Persistent Disk disks", () => {
    expect(
      classifyInPlaceMachineChange({
        ...base,
        diskTypes: ["pd-balanced", "local-ssd"],
      }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Local SSD"),
    });
    expect(
      classifyInPlaceMachineChange({
        ...base,
        diskTypes: ["pd-balanced", "hyperdisk-balanced"],
      }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("hyperdisk-balanced"),
    });
  });

  it("attaches GPUs only to N1, and only to a boot disk with NVIDIA drivers", () => {
    const gpu = [{ type: "nvidia-tesla-t4", count: 1 }];
    expect(
      classifyInPlaceMachineChange({
        ...base,
        targetMachineType: "n2d-standard-8",
        targetAccelerators: gpu,
        bootImageHasGpuDrivers: true,
      }).ok,
    ).toBe(false);
    expect(
      classifyInPlaceMachineChange({
        ...base,
        currentMachineType: "n1-standard-8",
        targetMachineType: "n1-standard-8",
        targetAccelerators: gpu,
        bootImageHasGpuDrivers: false,
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("driver") });
    expect(
      classifyInPlaceMachineChange({
        ...base,
        currentMachineType: "n1-standard-8",
        targetMachineType: "n1-standard-8",
        targetAccelerators: gpu,
        bootImageHasGpuDrivers: true,
      }).ok,
    ).toBe(true);
    // changing an attached GPU keeps the drivers it already had
    expect(
      classifyInPlaceMachineChange({
        ...base,
        currentMachineType: "n1-standard-8",
        targetMachineType: "n1-standard-16",
        currentAccelerators: gpu,
        targetAccelerators: [{ type: "nvidia-tesla-t4", count: 2 }],
      }).ok,
    ).toBe(true);
  });
});
