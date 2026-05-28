/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { HostMachine } from "@cocalc/conat/hub/api/hosts";
import { normalizeProviderId } from "@cocalc/cloud";

export const SHARED_SCRATCH_HOST_MOUNT = "/mnt/cocalc-scratch";
export const SHARED_SCRATCH_FILESYSTEM = "ext4";
export const NEBIUS_DISK_INCREMENT_GB = 93;
export const GCP_SHARED_SCRATCH_MIN_GB = 10;

type ScratchDiskType = NonNullable<HostMachine["shared_disk_type"]>;

const GCP_SHARED_SCRATCH_DISK_TYPES = new Set<ScratchDiskType>([
  "balanced",
  "ssd",
  "standard",
]);

const NEBIUS_SHARED_SCRATCH_DISK_TYPES = new Set<ScratchDiskType>([
  "balanced",
  "ssd",
  "ssd_io_m3",
]);

export function defaultSharedScratchDiskType(
  cloud?: string | null,
): ScratchDiskType | undefined {
  switch (normalizeProviderId(cloud)) {
    case "gcp":
      return "balanced";
    case "nebius":
      return "ssd";
    default:
      return undefined;
  }
}

export function minSharedScratchDiskSizeGib(cloud?: string | null): number {
  switch (normalizeProviderId(cloud)) {
    case "gcp":
      return GCP_SHARED_SCRATCH_MIN_GB;
    case "nebius":
      return NEBIUS_DISK_INCREMENT_GB;
    default:
      return 1;
  }
}

function supportedSharedScratchDiskTypes(
  cloud?: string | null,
): Set<ScratchDiskType> | undefined {
  switch (normalizeProviderId(cloud)) {
    case "gcp":
      return GCP_SHARED_SCRATCH_DISK_TYPES;
    case "nebius":
      return NEBIUS_SHARED_SCRATCH_DISK_TYPES;
    default:
      return undefined;
  }
}

function parseScratchDiskGb(value: unknown): number | undefined {
  if (value == null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("shared_disk_gb must be a positive number");
  }
  return Math.floor(parsed);
}

export function normalizeSharedScratchDiskSizeGib({
  cloud,
  sizeGb,
}: {
  cloud?: string | null;
  sizeGb: number;
}): number {
  const normalized = Math.max(
    minSharedScratchDiskSizeGib(cloud),
    Math.floor(sizeGb),
  );
  if (normalizeProviderId(cloud) === "nebius") {
    return (
      Math.ceil(normalized / NEBIUS_DISK_INCREMENT_GB) *
      NEBIUS_DISK_INCREMENT_GB
    );
  }
  return normalized;
}

export function normalizeSharedScratchMachineInPlace(
  machine: HostMachine,
  opts?: { current?: HostMachine; allowShrink?: boolean },
): HostMachine {
  const cloud = normalizeProviderId(machine.cloud);
  const requestedSize = parseScratchDiskGb(machine.shared_disk_gb);
  if (requestedSize == null) {
    delete machine.shared_disk_gb;
    delete machine.shared_disk_type;
    return machine;
  }
  const supportedTypes = supportedSharedScratchDiskTypes(cloud);
  if (!supportedTypes) {
    throw new Error(
      `shared scratch disks are not supported for provider '${machine.cloud ?? "local"}'`,
    );
  }
  const diskType =
    machine.shared_disk_type ?? defaultSharedScratchDiskType(cloud);
  if (!diskType || !supportedTypes.has(diskType)) {
    throw new Error(
      `shared_disk_type '${machine.shared_disk_type ?? ""}' is not supported for provider '${cloud}'`,
    );
  }
  const nextSize = normalizeSharedScratchDiskSizeGib({
    cloud,
    sizeGb: requestedSize,
  });
  const currentSize = Number(opts?.current?.shared_disk_gb ?? 0);
  if (
    opts?.allowShrink !== true &&
    Number.isFinite(currentSize) &&
    currentSize > 0 &&
    nextSize < currentSize
  ) {
    throw new Error(
      "Shared scratch disks cannot be shrunk in place. Delete the scratch disk and create a smaller one.",
    );
  }
  machine.shared_disk_gb = nextSize;
  machine.shared_disk_type = diskType;
  machine.metadata = {
    ...(machine.metadata ?? {}),
    shared_disk_mount: SHARED_SCRATCH_HOST_MOUNT,
    shared_disk_filesystem: SHARED_SCRATCH_FILESYSTEM,
  };
  return machine;
}
