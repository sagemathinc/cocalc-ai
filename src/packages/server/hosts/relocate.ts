/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Move a cloud project host to another zone and/or machine type while keeping
// everything on its data disk (projects, btrfs snapshots, host state).
//
// Across zones the data disk travels as a GCP snapshot: a warm snapshot while
// the host runs, then, during the maintenance window, a short incremental
// final snapshot, deprovision, restore the disk under the name provisioning
// reuses, and start. Within a zone only the machine type changes. Users of the
// host's projects see a maintenance banner with the expected end time.
//
// If anything fails during the window, the host is put back where it was from
// the same final snapshot, so the worst case is a longer window, not data loss.

import type { HostMaintenanceNotice } from "@cocalc/conat/hub/api/hosts";
import type { DataDiskSnapshot } from "@cocalc/cloud";
import { mapCloudRegionToR2Region } from "@cocalc/util/consts/r2-regions";

const STOP_MS = 60_000;
const FINAL_SNAPSHOT_MS = 150_000;
const DEPROVISION_MS = 20_000;
const START_MS = 180_000;
const SET_MACHINE_TYPE_MS = 15_000;
// Restoring a snapshot into another region took 163 s for 112 GB and 126 s
// for 255 GB on staging2: mostly fixed cost, then about 1.5 GB/s or better.
const RESTORE_BYTES_PER_MS = 1_500_000;
const MIN_RESTORE_MS = 120_000;
const ESTIMATE_MARGIN = 1.2;

export interface RelocationInput {
  zone?: string;
  machine_type?: string;
  expected_minutes?: number;
  message?: string;
  skip_backups?: boolean;
  keep_snapshot?: boolean;
}

export interface RelocationPlan {
  source: { zone: string; region: string; machine_type: string };
  target: { zone: string; region: string; machine_type: string };
  cross_zone: boolean;
  data_disk_name: string;
}

export function regionOfZone(zone: string): string {
  return zone.replace(/-[a-z]$/, "");
}

export function planRelocation(
  row: any,
  input: RelocationInput,
): RelocationPlan {
  const metadata = row?.metadata ?? {};
  const machine = metadata.machine ?? {};
  const runtime = metadata.runtime ?? {};
  if (`${machine.cloud ?? ""}`.trim().toLowerCase() !== "gcp") {
    throw new Error("relocation is only supported for GCP hosts");
  }
  if (`${machine.storage_mode ?? "persistent"}` !== "persistent") {
    throw new Error("relocation requires a persistent data disk");
  }
  const status = `${row?.status ?? ""}`;
  if (status !== "running" && status !== "off") {
    throw new Error(
      `relocation requires a running or stopped host (status: ${status || "unknown"})`,
    );
  }
  const sourceZone = `${runtime.zone ?? machine.zone ?? ""}`.trim();
  const instanceName = `${runtime.instance_id ?? ""}`.trim();
  if (!sourceZone || !instanceName) {
    throw new Error("host is not provisioned");
  }
  const sourceMachineType = `${machine.machine_type ?? ""}`.trim();
  const targetZone = `${input.zone ?? ""}`.trim() || sourceZone;
  if (!/^[a-z]+-[a-z]+[0-9]+-[a-z]$/.test(targetZone)) {
    throw new Error(`invalid zone '${targetZone}'`);
  }
  const targetMachineType =
    `${input.machine_type ?? ""}`.trim() || sourceMachineType;
  if (!targetMachineType) {
    throw new Error("host has no machine type");
  }
  const sourceRegion = `${row.region ?? regionOfZone(sourceZone)}`;
  const targetRegion = regionOfZone(targetZone);
  // Project backups live in the R2 region of the host's cloud region; moving
  // across R2 regions would also need every project's backups cut over.
  if (
    mapCloudRegionToR2Region(sourceRegion) !==
    mapCloudRegionToR2Region(targetRegion)
  ) {
    throw new Error(
      `${sourceRegion} and ${targetRegion} use different backup regions; relocation must stay within one backup region`,
    );
  }
  const crossZone = targetZone !== sourceZone;
  if (!crossZone && targetMachineType === sourceMachineType) {
    throw new Error("nothing to do: same zone and machine type");
  }
  return {
    source: {
      zone: sourceZone,
      region: sourceRegion,
      machine_type: sourceMachineType,
    },
    target: {
      zone: targetZone,
      region: targetRegion,
      machine_type: targetMachineType,
    },
    cross_zone: crossZone,
    // The name provisioning looks for, so it attaches the restored disk.
    data_disk_name:
      `${machine.metadata?.data_disk_name ?? ""}`.trim() ||
      `${instanceName}-data`,
  };
}

// Expected maintenance window: measured step times plus a restore time
// proportional to the data on the disk, with a safety margin.
export function estimateRelocationWindowMs(opts: {
  cross_zone: boolean;
  data_bytes?: number;
  running: boolean;
}): number {
  const stop = opts.running ? STOP_MS : 0;
  const move = opts.cross_zone
    ? FINAL_SNAPSHOT_MS +
      DEPROVISION_MS +
      Math.max(MIN_RESTORE_MS, (opts.data_bytes ?? 0) / RESTORE_BYTES_PER_MS)
    : SET_MACHINE_TYPE_MS;
  const ms = (stop + move + START_MS) * ESTIMATE_MARGIN;
  return Math.ceil(ms / 60_000) * 60_000;
}

// GCP snapshot names: lowercase letters, digits and dashes, at most 63
// characters, starting with a letter.
export function relocationSnapshotName(
  host_id: string,
  stage: "warm" | "final",
  now: Date,
): string {
  const stamp = now
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 12);
  const id = host_id.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 12);
  return `reloc-${id}-${stamp}-${stage}`;
}

export interface RelocationDeps {
  loadHost: () => Promise<any>;
  // Merge into metadata (and optionally set region) on the host row.
  updateHost: (update: {
    metadata: Record<string, any>;
    region?: string;
  }) => Promise<void>;
  setMaintenance: (notice: HostMaintenanceNotice | null) => Promise<void>;
  provider: () => Promise<{ provider: any; creds: any }>;
  machineTypeShape?: (
    zone: string,
    machine_type: string,
  ) => Promise<{ cpu: number; ram_gb: number } | undefined>;
  backupProjects: () => Promise<void>;
  stopHost: () => Promise<void>;
  // Deprovisioning marks every project on the host unprovisioned (its data
  // is normally gone), which makes the next start restore from backup over
  // the local volume. A relocation keeps the data, so it records which
  // projects are provisioned and marks them provisioned again right after.
  loadProvisionedProjectIds: () => Promise<string[]>;
  markProjectsProvisioned: (project_ids: string[]) => Promise<void>;
  deprovisionHost: () => Promise<void>;
  // A rollback start waits as long as it takes; the planned start is bounded.
  startHost: (opts?: { rollback?: boolean }) => Promise<void>;
  // Fails if the host could not start as planned (e.g. no price for the
  // target machine type), checked before anything is changed.
  preflight?: (target: RelocationPlan["target"]) => Promise<void>;
  progress: (step: string, message: string, detail?: any) => Promise<void>;
  shouldCancel: () => Promise<boolean>;
  alert?: (subject: string, body: string) => Promise<void>;
  now?: () => number;
}

export interface RelocationResult {
  plan: RelocationPlan;
  window_ms: number;
  expected_window_ms: number;
  steps_ms: Record<string, number>;
  snapshots_kept: string[];
}

function withPlacement(
  metadata: Record<string, any>,
  placement: { zone: string; machine_type: string },
  shape?: { cpu: number; ram_gb: number },
): Record<string, any> {
  const machine = metadata.machine ?? {};
  const machineType = placement.machine_type;
  return {
    ...metadata,
    size: machineType,
    machine: {
      ...machine,
      zone: placement.zone,
      machine_type: machineType,
      metadata: {
        ...(machine.metadata ?? {}),
        ...(shape ? { cpu: shape.cpu, ram_gb: shape.ram_gb } : {}),
      },
    },
    // A new desired placement starts with a clean Spot recovery state.
    spot_recovery_state: { phase: "idle", active_machine_type: machineType },
  };
}

export async function relocateHost({
  host_id,
  op_id,
  input,
  deps,
}: {
  host_id: string;
  op_id?: string;
  input: RelocationInput;
  deps: RelocationDeps;
}): Promise<RelocationResult> {
  const now = deps.now ?? Date.now;
  const steps_ms: Record<string, number> = {};
  const timed = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const started = now();
    try {
      return await run();
    } finally {
      steps_ms[name] = now() - started;
    }
  };
  const checkCancel = async () => {
    if (await deps.shouldCancel()) {
      throw new Error("relocation canceled");
    }
  };

  const row = await deps.loadHost();
  const plan = planRelocation(row, input);
  const running = row.status === "running";
  const { provider, creds } = await deps.provider();
  const runtime = row.metadata?.runtime ?? {};
  if (
    plan.cross_zone &&
    (!provider?.snapshotDataDisk ||
      !provider?.createDataDiskFromSnapshot ||
      !provider?.deleteSnapshot)
  ) {
    throw new Error("provider does not support data disk snapshots");
  }
  if (!plan.cross_zone && !provider?.setMachineType) {
    throw new Error("provider does not support changing the machine type");
  }
  const shape = await deps.machineTypeShape?.(
    plan.target.zone,
    plan.target.machine_type,
  );
  if (deps.machineTypeShape && !shape) {
    throw new Error(
      `${plan.target.machine_type} is not offered in ${plan.target.zone}`,
    );
  }

  await deps.preflight?.(plan.target);

  // Online preparation: users are not affected yet.
  if (running && !input.skip_backups) {
    await deps.progress("backups", "backing up projects while still online");
    await timed("backups", deps.backupProjects);
  }
  await checkCancel();
  let warm: DataDiskSnapshot | undefined;
  if (plan.cross_zone) {
    await deps.progress("warm-snapshot", "snapshotting the data disk online");
    warm = await timed(
      "warm_snapshot",
      async () =>
        await provider.snapshotDataDisk(
          runtime,
          relocationSnapshotName(host_id, "warm", new Date(now())),
          creds,
        ),
    );
  }
  await checkCancel();

  const expected_window_ms =
    input.expected_minutes && input.expected_minutes > 0
      ? input.expected_minutes * 60_000
      : estimateRelocationWindowMs({
          cross_zone: plan.cross_zone,
          data_bytes: warm?.storage_bytes,
          running,
        });

  // Maintenance window.
  const windowStarted = now();
  const notice: HostMaintenanceNotice = {
    kind: "relocation",
    state: "in_progress",
    started_at: new Date(windowStarted).toISOString(),
    expected_duration_ms: expected_window_ms,
    expected_end_at: new Date(windowStarted + expected_window_ms).toISOString(),
    ...(input.message ? { message: input.message } : {}),
    ...(op_id ? { op_id } : {}),
  };
  await deps.setMaintenance(notice);

  let final: DataDiskSnapshot | undefined;
  let provisionedProjectIds: string[] = [];
  let deprovisioned = false;
  let targetDiskCreated = false;
  try {
    if (running) {
      await deps.progress("stopping", "stopping the host");
      await timed("stop", deps.stopHost);
    }
    if (plan.cross_zone) {
      await deps.progress("final-snapshot", "taking the final snapshot");
      const finalSnapshot: DataDiskSnapshot = await timed(
        "final_snapshot",
        async () =>
          await provider.snapshotDataDisk(
            runtime,
            relocationSnapshotName(host_id, "final", new Date(now())),
            creds,
          ),
      );
      final = finalSnapshot;
      await deps.progress("deprovision", "removing the old VM and disks", {
        snapshot: finalSnapshot.name,
      });
      provisionedProjectIds = await deps.loadProvisionedProjectIds();
      await timed("deprovision", deps.deprovisionHost);
      deprovisioned = true;
      await deps.markProjectsProvisioned(provisionedProjectIds);
      const current = await deps.loadHost();
      await deps.updateHost({
        region: plan.target.region,
        metadata: withPlacement(current.metadata ?? {}, plan.target, shape),
      });
      await deps.progress("restore", `restoring the data disk in ${plan.target.zone}`);
      await timed(
        "restore",
        async () =>
          await provider.createDataDiskFromSnapshot(
            {
              zone: plan.target.zone,
              disk_name: plan.data_disk_name,
              snapshot_name: finalSnapshot.name,
              disk_type: finalSnapshot.disk_type,
              size_gb: finalSnapshot.disk_size_gb,
            },
            creds,
          ),
      );
      targetDiskCreated = true;
    } else {
      await deps.progress(
        "machine-type",
        `changing the machine type to ${plan.target.machine_type}`,
      );
      await timed("set_machine_type", async () => {
        await provider.setMachineType(runtime, plan.target.machine_type, creds);
        const current = await deps.loadHost();
        await deps.updateHost({
          metadata: withPlacement(current.metadata ?? {}, plan.target, shape),
        });
      });
    }
    await deps.progress("starting", `starting the host in ${plan.target.zone}`);
    await timed("start", deps.startHost);
  } catch (err) {
    const rollback = await rollBack({
      plan,
      final,
      deprovisioned,
      targetDiskCreated,
      provisionedProjectIds,
      original: {
        region: `${row.region ?? plan.source.region}`,
        machine: row.metadata?.machine ?? {},
        size: row.metadata?.size,
      },
      provider,
      creds,
      deps,
      timed,
    });
    await deps.setMaintenance(
      rollback.ok
        ? null
        : {
            ...notice,
            state: "failed",
            message:
              "This maintenance is taking longer than planned. CoCalc staff have been notified and are restoring the host.",
          },
    );
    await deps.alert?.(
      `Host relocation failed: ${host_id}`,
      [
        `Relocation ${plan.source.zone}/${plan.source.machine_type} -> ${plan.target.zone}/${plan.target.machine_type} failed: ${err}`,
        rollback.ok
          ? `Rolled back to ${plan.source.zone}; the host is running there again.`
          : `Rollback failed: ${rollback.error}. Final snapshot: ${final?.name ?? "none"}.`,
      ].join("\n\n"),
    );
    throw new Error(
      `relocation failed: ${err}${
        rollback.ok
          ? `; rolled back to ${plan.source.zone}`
          : `; rollback failed: ${rollback.error} (snapshot ${final?.name ?? "none"} kept)`
      }`,
    );
  }
  const window_ms = now() - windowStarted;
  await deps.setMaintenance(null);

  const snapshots_kept: string[] = [];
  for (const snapshot of [warm, final]) {
    if (!snapshot) continue;
    if (snapshot === final && input.keep_snapshot) {
      snapshots_kept.push(snapshot.name);
      continue;
    }
    try {
      await provider.deleteSnapshot(snapshot.name, creds);
    } catch (err) {
      snapshots_kept.push(snapshot.name);
      await deps.progress("cleanup", `could not delete snapshot ${snapshot.name}`, {
        error: `${err}`,
      });
    }
  }
  await deps.progress("done", "relocation complete", {
    window_ms,
    expected_window_ms,
  });
  return { plan, window_ms, expected_window_ms, steps_ms, snapshots_kept };
}

async function rollBack({
  plan,
  final,
  deprovisioned,
  targetDiskCreated,
  provisionedProjectIds,
  original,
  provider,
  creds,
  deps,
  timed,
}: {
  plan: RelocationPlan;
  final?: DataDiskSnapshot;
  deprovisioned: boolean;
  targetDiskCreated: boolean;
  provisionedProjectIds: string[];
  original: { region: string; machine: Record<string, any>; size?: string };
  provider: any;
  creds: any;
  deps: RelocationDeps;
  timed: <T>(name: string, run: () => Promise<T>) => Promise<T>;
}): Promise<{ ok: boolean; error?: string }> {
  const restorePlacement = (metadata: Record<string, any>) => ({
    ...metadata,
    machine: original.machine,
    ...(original.size ? { size: original.size } : {}),
    spot_recovery_state: {
      phase: "idle",
      active_machine_type: plan.source.machine_type,
    },
  });
  try {
    await deps.progress("rollback", `rolling back to ${plan.source.zone}`);
    await timed("rollback", async () => {
      if (plan.cross_zone && deprovisioned) {
        if (!final) throw new Error("no final snapshot");
        const current = await deps.loadHost();
        if (current.status !== "deprovisioned") {
          await deps.deprovisionHost();
          await deps.markProjectsProvisioned(provisionedProjectIds);
        }
        if (targetDiskCreated) {
          await provider.deleteDataDisk?.(
            { zone: plan.target.zone, disk_name: plan.data_disk_name },
            creds,
          );
        }
        const reloaded = await deps.loadHost();
        await deps.updateHost({
          region: original.region,
          metadata: restorePlacement(reloaded.metadata ?? {}),
        });
        await provider.createDataDiskFromSnapshot(
          {
            zone: plan.source.zone,
            disk_name: plan.data_disk_name,
            snapshot_name: final.name,
            disk_type: final.disk_type,
            size_gb: final.disk_size_gb,
          },
          creds,
        );
      } else if (!plan.cross_zone) {
        const current = await deps.loadHost();
        if (
          `${current.metadata?.machine?.machine_type ?? ""}` !==
          plan.source.machine_type
        ) {
          await provider.setMachineType(
            current.metadata?.runtime ?? {},
            plan.source.machine_type,
            creds,
          );
          await deps.updateHost({
            metadata: restorePlacement(current.metadata ?? {}),
          });
        }
      }
      const current = await deps.loadHost();
      if (current.status !== "running") {
        await deps.startHost({ rollback: true });
      }
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `${err}` };
  }
}
