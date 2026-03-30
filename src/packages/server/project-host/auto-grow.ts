/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { createHostControlClient } from "@cocalc/conat/project-host/api";
import type { HostMachine } from "@cocalc/conat/hub/api/hosts";
import { normalizeProviderId } from "@cocalc/cloud";
import { logCloudVmEvent } from "@cocalc/server/cloud";
import {
  getProviderContext,
  getProviderPrefix,
} from "@cocalc/server/cloud/provider-context";
import { conatWithProjectRouting } from "@cocalc/server/conat/route-client";
import { getServerProvider, gcpSafeName } from "@cocalc/server/cloud/providers";

const log = getLogger("server:project-host:auto-grow");
const GIB = 1024 ** 3;
const DEFAULT_MAX_DISK_GB = Math.max(
  50,
  Math.floor(Number(process.env.COCALC_HOST_AUTO_GROW_MAX_DISK_GB ?? 500)),
);
const DEFAULT_GROWTH_STEP_GB = Math.max(
  10,
  Math.floor(Number(process.env.COCALC_HOST_AUTO_GROW_STEP_GB ?? 50)),
);
const DEFAULT_MIN_GROW_INTERVAL_MINUTES = Math.max(
  1,
  Math.floor(
    Number(process.env.COCALC_HOST_AUTO_GROW_MIN_INTERVAL_MINUTES ?? 60),
  ),
);
const ENABLED_PROVIDERS = new Set(
  `${process.env.COCALC_HOST_AUTO_GROW_PROVIDERS ?? "gcp"}`
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);
const autoGrowInFlight = new Map<string, Promise<AutoGrowResult>>();

type HostRow = {
  id: string;
  name?: string;
  region?: string;
  status?: string;
  metadata?: Record<string, any>;
};

type AutoGrowConfig = {
  enabled: boolean;
  max_disk_gb: number;
  growth_step_gb: number;
  min_grow_interval_minutes: number;
};

export type AutoGrowResult = {
  grown: boolean;
  next_disk_gb?: number;
  reason?: string;
};

const pool = () => getPool();

function parseBooleanLike(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function parsePositiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function reservationErrorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return `${err ?? ""}`;
}

export function isStorageReservationDeniedError(err: unknown): boolean {
  return reservationErrorText(err)
    .toLowerCase()
    .includes("host storage reservation denied");
}

function resolveAutoGrowConfig(row: HostRow): AutoGrowConfig | undefined {
  const machine: HostMachine = row.metadata?.machine ?? {};
  const machineMeta = machine.metadata ?? {};
  const nested = machineMeta.auto_grow ?? {};
  const provider = normalizeProviderId(machine.cloud) ?? "";
  const envEnabled = parseBooleanLike(
    process.env.COCALC_HOST_AUTO_GROW_ENABLED,
  );
  const explicitEnabled =
    parseBooleanLike(nested.enabled) ??
    parseBooleanLike(machineMeta.auto_grow_enabled);
  const enabled =
    explicitEnabled ?? (envEnabled === true && ENABLED_PROVIDERS.has(provider));
  if (!enabled) return;
  return {
    enabled: true,
    max_disk_gb:
      parsePositiveInt(nested.max_disk_gb) ??
      parsePositiveInt(machineMeta.auto_grow_max_disk_gb) ??
      DEFAULT_MAX_DISK_GB,
    growth_step_gb:
      parsePositiveInt(nested.growth_step_gb) ??
      parsePositiveInt(machineMeta.auto_grow_growth_step_gb) ??
      DEFAULT_GROWTH_STEP_GB,
    min_grow_interval_minutes:
      parsePositiveInt(nested.min_grow_interval_minutes) ??
      parsePositiveInt(machineMeta.auto_grow_min_grow_interval_minutes) ??
      DEFAULT_MIN_GROW_INTERVAL_MINUTES,
  };
}

function currentDiskGb(row: HostRow): number | undefined {
  const machine: HostMachine = row.metadata?.machine ?? {};
  const configured = parsePositiveInt(machine.disk_gb);
  if (configured != null) return configured;
  const observedBytes = Number(
    row.metadata?.metrics?.current?.disk_device_total_bytes,
  );
  if (!Number.isFinite(observedBytes) || observedBytes <= 0) return undefined;
  return Math.max(1, Math.ceil(observedBytes / GIB));
}

function nextDiskSizeGb(
  currentDiskGbValue: number | undefined,
  config: AutoGrowConfig,
): number | undefined {
  if (currentDiskGbValue == null || currentDiskGbValue <= 0) return undefined;
  if (currentDiskGbValue >= config.max_disk_gb) return undefined;
  return Math.min(
    config.max_disk_gb,
    currentDiskGbValue + Math.max(1, config.growth_step_gb),
  );
}

function canAutoGrowNow(
  row: HostRow,
  config: AutoGrowConfig,
): string | undefined {
  const machine: HostMachine = row.metadata?.machine ?? {};
  const providerId = normalizeProviderId(machine.cloud);
  if (providerId !== "gcp") {
    return "provider is not enabled for guarded auto-grow";
  }
  const provider = getServerProvider(providerId);
  if (!provider?.entry.capabilities.supportsDiskResize) {
    return "provider does not support disk resize";
  }
  if (provider.entry.capabilities.diskResizeRequiresStop) {
    return "provider requires stop for disk resize";
  }
  if (machine.storage_mode === "ephemeral") {
    return "host uses ephemeral storage";
  }
  const lastGrowAt = row.metadata?.machine?.metadata?.auto_grow?.last_grow_at;
  const lastGrowMs = Number.isFinite(Date.parse(lastGrowAt ?? ""))
    ? Date.parse(lastGrowAt)
    : undefined;
  if (
    lastGrowMs != null &&
    Date.now() - lastGrowMs < config.min_grow_interval_minutes * 60 * 1000
  ) {
    return "minimum grow interval has not elapsed";
  }
  return undefined;
}

async function loadHostRow(host_id: string): Promise<HostRow | undefined> {
  const { rows } = await pool().query<HostRow>(
    `SELECT id, name, region, status, metadata
     FROM project_hosts
     WHERE id=$1 AND deleted IS NULL`,
    [host_id],
  );
  return rows[0];
}

async function ensureRuntimeForResize(
  row: HostRow,
): Promise<{ runtime: any; providerId: "gcp" }> {
  const metadata = row.metadata ?? {};
  const machine: HostMachine = metadata.machine ?? {};
  const providerId = normalizeProviderId(machine.cloud);
  if (providerId !== "gcp") {
    throw new Error("provider is not eligible for guarded auto-grow");
  }
  let runtime = metadata.runtime ?? {};
  if (!runtime.instance_id) {
    const zone = runtime.zone ?? machine.zone ?? undefined;
    if (!zone) {
      throw new Error("host runtime does not include a resizeable zone");
    }
    const prefix = await getProviderPrefix(
      providerId,
      await getServerSettings(),
    );
    const provider = getServerProvider(providerId);
    const normalizeName = provider?.normalizeName ?? gcpSafeName;
    const baseName = row.id.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    runtime = {
      ...runtime,
      instance_id: normalizeName(prefix, baseName),
      zone,
    };
  }
  return { runtime, providerId };
}

async function performAutoGrow(
  row: HostRow,
  config: AutoGrowConfig,
): Promise<AutoGrowResult> {
  const machine: HostMachine = row.metadata?.machine ?? {};
  const currentDisk = currentDiskGb(row);
  const nextDisk = nextDiskSizeGb(currentDisk, config);
  if (nextDisk == null) {
    return {
      grown: false,
      reason:
        currentDisk != null && currentDisk >= config.max_disk_gb
          ? "host is already at the configured auto-grow max disk size"
          : "host does not have a known current disk size",
    };
  }

  const blockedReason = canAutoGrowNow(row, config);
  if (blockedReason) {
    return { grown: false, reason: blockedReason };
  }

  const { runtime, providerId } = await ensureRuntimeForResize(row);
  const { entry, creds } = await getProviderContext(providerId, {
    region: row.region,
  });
  await entry.provider.resizeDisk(runtime, nextDisk, creds);

  let resizeWarning: string | undefined;
  const client = createHostControlClient({
    host_id: row.id,
    client: conatWithProjectRouting(),
  });
  try {
    await client.growBtrfs({ disk_gb: nextDisk });
  } catch (err) {
    resizeWarning =
      "disk resized in cloud, but filesystem resize failed; reboot or run /usr/local/sbin/cocalc-grow-btrfs";
    log.warn("auto-grow growBtrfs failed", {
      host_id: row.id,
      nextDisk,
      err,
    });
  }

  const nowIso = new Date().toISOString();
  const nextMachineMeta = {
    ...(machine.metadata ?? {}),
    auto_grow: {
      ...((machine.metadata ?? {}).auto_grow ?? {}),
      enabled: true,
      max_disk_gb: config.max_disk_gb,
      growth_step_gb: config.growth_step_gb,
      min_grow_interval_minutes: config.min_grow_interval_minutes,
      last_grow_at: nowIso,
      last_grow_from_disk_gb: currentDisk,
      last_grow_to_disk_gb: nextDisk,
    },
  };
  const nextMetadata = {
    ...(row.metadata ?? {}),
    machine: {
      ...machine,
      disk_gb: nextDisk,
      metadata: nextMachineMeta,
    },
    last_action: "auto_grow_disk",
    last_action_status: resizeWarning ? `warning: ${resizeWarning}` : "success",
    last_action_error: resizeWarning ?? null,
    last_action_at: nowIso,
  };
  await pool().query(
    `UPDATE project_hosts
     SET metadata=$2, updated=NOW()
     WHERE id=$1 AND deleted IS NULL`,
    [row.id, nextMetadata],
  );
  await logCloudVmEvent({
    vm_id: row.id,
    action: "resize",
    status: resizeWarning ? "warning" : "success",
    provider: providerId,
    spec: {
      auto_grow: true,
      from_disk_gb: currentDisk,
      to_disk_gb: nextDisk,
    },
  });

  return resizeWarning
    ? { grown: false, next_disk_gb: nextDisk, reason: resizeWarning }
    : { grown: true, next_disk_gb: nextDisk };
}

export async function maybeAutoGrowHostDiskForReservationFailure({
  host_id,
  err,
}: {
  host_id: string;
  err: unknown;
}): Promise<AutoGrowResult> {
  if (!isStorageReservationDeniedError(err)) {
    return {
      grown: false,
      reason: "error was not a storage reservation denial",
    };
  }
  const existing = autoGrowInFlight.get(host_id);
  if (existing) return await existing;
  const task = (async (): Promise<AutoGrowResult> => {
    const row = await loadHostRow(host_id);
    if (!row) return { grown: false, reason: "host not found" };
    const config = resolveAutoGrowConfig(row);
    if (!config) {
      return {
        grown: false,
        reason: "guarded auto-grow is not enabled for this host",
      };
    }
    log.info("attempting guarded host auto-grow", {
      host_id,
      reason: reservationErrorText(err),
      config,
    });
    try {
      return await performAutoGrow(row, config);
    } catch (growErr) {
      log.warn("guarded host auto-grow failed", {
        host_id,
        err: growErr,
      });
      return { grown: false, reason: reservationErrorText(growErr) };
    }
  })();
  autoGrowInFlight.set(host_id, task);
  try {
    return await task;
  } finally {
    if (autoGrowInFlight.get(host_id) === task) {
      autoGrowInFlight.delete(host_id);
    }
  }
}

export const _test = {
  resolveAutoGrowConfig,
  nextDiskSizeGb,
  canAutoGrowNow,
  currentDiskGb,
};
