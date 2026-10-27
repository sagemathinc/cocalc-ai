/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Which machine changes GCP can make to an existing (stopped) instance, so its
boot disk is kept, and which need a new instance.

From "Edit the machine type of a compute instance"
(https://docs.cloud.google.com/compute/docs/instances/changing-machine-type-of-stopped-instance):
- the instance must be stopped, without Local SSD;
- "This is supported for only first and second generation machine series,
  excluding the T2A and A2 machine series";
- not to a third generation or later series, not to Arm, not for
  accelerator-optimized or bare metal instances: "Move your workload to a new
  compute instance" instead.
Third generation and later series also need disks they can attach: N4, N4D,
C4 and C4D take only Hyperdisk, C3 and C3D only NVMe
(https://docs.cloud.google.com/compute/docs/general-purpose-machines), and
C3/C3D need gVNIC, which an existing instance can't switch to.

GPUs ("Add or remove GPUs",
https://docs.cloud.google.com/compute/docs/gpus/add-remove-gpus): only N1
takes attached GPUs (setMachineResources), with onHostMaintenance=TERMINATE.
A GPU host also boots an image with the NVIDIA drivers, so a GPU can only be
attached in place to a boot disk built from such an image.
*/

// First and second generation x86 series, including the memory-optimized
// M1 and M2 (not T2A, which is Arm, nor A2, which is accelerator-optimized).
const IN_PLACE_FAMILIES = new Set([
  "e2",
  "n1",
  "n2",
  "n2d",
  "t2d",
  "c2",
  "c2d",
  "m1",
  "m2",
]);

// Persistent Disk types, which every series above can attach.
const PERSISTENT_DISK_TYPES = new Set(["pd-balanced", "pd-ssd", "pd-standard"]);

export const MACHINE_CHANGE_REQUIRES_NEW_INSTANCE =
  "machine_change_requires_new_instance";

export interface GuestAccelerator {
  type: string;
  count: number;
}

export function machineFamily(machineType: string): string {
  return `${machineType ?? ""}`.trim().toLowerCase().split("-")[0] ?? "";
}

export function sameAccelerators(
  a: GuestAccelerator[],
  b: GuestAccelerator[],
): boolean {
  const key = (list: GuestAccelerator[]) =>
    list
      .map(({ type, count }) => `${type}:${count}`)
      .sort()
      .join(",");
  return key(a) === key(b);
}

export function classifyInPlaceMachineChange(opts: {
  currentMachineType: string;
  targetMachineType: string;
  currentAccelerators: GuestAccelerator[];
  targetAccelerators: GuestAccelerator[];
  // GCP disk type names of every attached disk, e.g. "pd-balanced"; Local
  // SSD is "local-ssd".
  diskTypes: string[];
  // Whether the boot disk was built from an image with the NVIDIA drivers.
  // Only needed when a GPU is attached to an instance without one.
  bootImageHasGpuDrivers?: boolean;
}): { ok: true } | { ok: false; reason: string } {
  const current = machineFamily(opts.currentMachineType);
  const target = machineFamily(opts.targetMachineType);
  if (opts.diskTypes.includes("local-ssd")) {
    return { ok: false, reason: "the instance has Local SSD attached" };
  }
  for (const [label, family, type] of [
    ["current", current, opts.currentMachineType],
    ["target", target, opts.targetMachineType],
  ]) {
    if (!IN_PLACE_FAMILIES.has(family)) {
      return {
        ok: false,
        reason: `the ${label} machine type ${type} is not a first or second generation x86 series (${[...IN_PLACE_FAMILIES].join(", ")})`,
      };
    }
  }
  const otherDisk = opts.diskTypes.find(
    (type) => !PERSISTENT_DISK_TYPES.has(type),
  );
  if (otherDisk) {
    return {
      ok: false,
      reason: `disk type ${otherDisk} is not a Persistent Disk type`,
    };
  }
  if (opts.targetAccelerators.length > 0) {
    if (target !== "n1") {
      return {
        ok: false,
        reason: `GPUs can only be attached to N1 machine types, not ${opts.targetMachineType}`,
      };
    }
    if (
      opts.currentAccelerators.length === 0 &&
      opts.bootImageHasGpuDrivers !== true
    ) {
      return {
        ok: false,
        reason:
          "the boot disk was not built from a GPU (NVIDIA driver) image, so a GPU can't be added in place",
      };
    }
  }
  return { ok: true };
}
