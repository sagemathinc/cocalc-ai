/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Host cloud lifecycle and power-transition helpers.

What belongs here:

- host creation persistence once caller auth/entitlement checks are done
- start/stop/restart execution flows for cloud and self-hosted hosts
- cloud VM work queue submission and the bootstrap metadata resets that go with
  those transitions
- self-host connector bootstrap on host start

What does not belong here:

- public API/LRO entrypoints
- unrelated teardown or runtime deployment logic
- host parsing and response-shaping utilities

`hosts.ts` keeps the public wrappers and surrounding host API surface while
this module owns the side-effecting lifecycle transitions.
*/

import type {
  Host,
  HostInterruptionRestorePolicy,
  HostPricingModel,
} from "@cocalc/conat/hub/api/hosts";
import { randomUUID } from "crypto";
import getPool from "@cocalc/database/pool";
import { normalizeProviderId } from "@cocalc/cloud";
import {
  ensureConnectorRecord,
  createConnectorRecord,
  createPairingTokenForHost,
} from "@cocalc/server/self-host/connector-tokens";
import {
  ensureSelfHostReverseTunnel,
  runConnectorInstallOverSsh,
} from "@cocalc/server/self-host/ssh-target";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { getServerProvider } from "@cocalc/server/cloud/providers";
import {
  machineHasGpu,
  normalizeMachineGpuInPlace,
} from "@cocalc/server/cloud/host-gpu";
import { hasCloudflareTunnel } from "@cocalc/server/cloud/cloudflare-tunnel";
import { enqueueCloudVmWork } from "@cocalc/server/cloud";
import { getConfiguredBayId } from "@cocalc/server/bay-config";

function pool() {
  return getPool();
}

export async function createHostInternalHelper({
  owner,
  name,
  region,
  size,
  gpu,
  pricing_model,
  interruption_restore_policy,
  machine,
  normalizeHostPricingModel,
  normalizeHostInterruptionRestorePolicy,
  defaultInterruptionRestorePolicy,
  parseRow,
}: {
  owner: string;
  name: string;
  region: string;
  size: string;
  gpu: boolean;
  pricing_model?: HostPricingModel;
  interruption_restore_policy?: HostInterruptionRestorePolicy;
  machine?: Host["machine"];
  normalizeHostPricingModel: (value: unknown) => HostPricingModel | undefined;
  normalizeHostInterruptionRestorePolicy: (
    value: unknown,
  ) => HostInterruptionRestorePolicy | undefined;
  defaultInterruptionRestorePolicy: (
    pricingModel?: HostPricingModel,
  ) => HostInterruptionRestorePolicy;
  parseRow: (
    row: any,
    opts?: { scope?: string; can_start?: boolean; can_place?: boolean },
  ) => Host;
}): Promise<Host> {
  const id = randomUUID();
  const machineCloud = normalizeProviderId(machine?.cloud);
  const isSelfHost = machineCloud === "self-host";
  const normalizedPricingModel = normalizeHostPricingModel(pricing_model);
  if (pricing_model != null && !normalizedPricingModel) {
    throw new Error(`invalid pricing_model '${pricing_model}'`);
  }
  const normalizedRestorePolicy = normalizeHostInterruptionRestorePolicy(
    interruption_restore_policy,
  );
  if (interruption_restore_policy != null && !normalizedRestorePolicy) {
    throw new Error(
      `invalid interruption_restore_policy '${interruption_restore_policy}'`,
    );
  }
  const pricingModel = normalizedPricingModel ?? "on_demand";
  const interruptionRestorePolicy =
    normalizedRestorePolicy ?? defaultInterruptionRestorePolicy(pricingModel);
  const initialStatus = machineCloud && !isSelfHost ? "starting" : "off";
  const initialDesiredState: "running" | "stopped" =
    machineCloud && !isSelfHost ? "running" : "stopped";
  const rawSelfHostMode = machine?.metadata?.self_host_mode;
  const selfHostMode =
    rawSelfHostMode === "cloudflare" || rawSelfHostMode === "local"
      ? rawSelfHostMode
      : undefined;
  if (isSelfHost && rawSelfHostMode && !selfHostMode) {
    throw new Error(`invalid self_host_mode '${rawSelfHostMode}'`);
  }
  const rawSelfHostKind = machine?.metadata?.self_host_kind;
  const selfHostKind =
    rawSelfHostKind === "direct" || rawSelfHostKind === "multipass"
      ? rawSelfHostKind
      : undefined;
  if (isSelfHost && rawSelfHostKind && !selfHostKind) {
    throw new Error(`invalid self_host_kind '${rawSelfHostKind}'`);
  }
  const effectiveSelfHostKind = isSelfHost
    ? (selfHostKind ?? "direct")
    : undefined;
  if (isSelfHost && selfHostMode === "cloudflare") {
    if (!(await hasCloudflareTunnel())) {
      throw new Error("cloudflare tunnel is not configured");
    }
  }
  const requestedBootstrapChannel =
    typeof machine?.metadata?.bootstrap_channel === "string"
      ? machine.metadata.bootstrap_channel.trim()
      : "";
  const requestedBootstrapVersion =
    typeof machine?.metadata?.bootstrap_version === "string"
      ? machine.metadata.bootstrap_version.trim()
      : "";
  let resolvedRegion = region;
  let connectorId: string | undefined;
  if (isSelfHost) {
    const connector = await createConnectorRecord({
      account_id: owner,
      host_id: id,
      name,
    });
    connectorId = connector.connector_id;
    resolvedRegion = connectorId;
  }
  const normalizedMachine = normalizeMachineGpuInPlace(
    {
      ...(machine ?? {}),
      ...(machineCloud ? { cloud: machineCloud } : {}),
      ...(connectorId
        ? {
            metadata: {
              ...(machine?.metadata ?? {}),
              connector_id: connectorId,
              ...(selfHostMode ? { self_host_mode: selfHostMode } : {}),
              ...(effectiveSelfHostKind
                ? { self_host_kind: effectiveSelfHostKind }
                : {}),
            },
          }
        : {}),
    },
    gpu,
  );
  const gpuEnabled = machineHasGpu(normalizedMachine);

  await pool().query(
    `INSERT INTO project_hosts (id, name, region, status, metadata, created, updated, last_seen, bay_id)
     VALUES ($1,$2,$3,$4,$5,NOW(),NOW(),$6,$7)`,
    [
      id,
      name,
      resolvedRegion,
      initialStatus,
      {
        owner,
        size,
        gpu: gpuEnabled,
        pricing_model: pricingModel,
        interruption_restore_policy: interruptionRestorePolicy,
        desired_state: initialDesiredState,
        machine: normalizedMachine,
        ...(machineCloud && !isSelfHost
          ? {
              bootstrap: {
                status: "queued",
                updated_at: new Date().toISOString(),
                message: "Waiting for cloud host bootstrap",
              },
            }
          : {}),
        ...(requestedBootstrapChannel
          ? { bootstrap_channel: requestedBootstrapChannel }
          : {}),
        ...(requestedBootstrapVersion
          ? { bootstrap_version: requestedBootstrapVersion }
          : {}),
      },
      null,
      getConfiguredBayId(),
    ],
  );
  if (machineCloud && !isSelfHost) {
    await enqueueCloudVmWork({
      vm_id: id,
      action: "provision",
      payload: { provider: machineCloud },
    });
  }
  const { rows } = await pool().query(
    `SELECT * FROM project_hosts WHERE id=$1 AND deleted IS NULL`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new Error("host not found after create");
  return parseRow(row, {
    scope: "owned",
    can_start: true,
    can_place: true,
  });
}

export async function startHostInternalHelper({
  account_id,
  id,
  loadHostForStartStop,
  markHostActionPending,
  logStatusUpdate,
  parseRow,
}: {
  account_id?: string;
  id: string;
  loadHostForStartStop: (id: string, account_id?: string) => Promise<any>;
  markHostActionPending: (id: string, action: string) => Promise<void>;
  logStatusUpdate: (id: string, status: string, source: string) => void;
  parseRow: (row: any, opts?: any) => Host;
}): Promise<Host> {
  const row = await loadHostForStartStop(id, account_id);
  const metadata = row.metadata ?? {};
  const owner = metadata.owner ?? account_id;
  const machine = metadata.machine ?? {};
  const machineCloud = normalizeProviderId(machine.cloud);
  const sshTarget = String(machine.metadata?.self_host_ssh_target ?? "").trim();
  if (machineCloud === "self-host" && sshTarget && owner) {
    await ensureSelfHostReverseTunnel({
      host_id: row.id,
      ssh_target: sshTarget,
    });
    const { rows: connectorRows } = await pool().query<{
      connector_id: string;
      last_seen: Date | null;
    }>(
      `SELECT connector_id, last_seen
         FROM self_host_connectors
        WHERE host_id=$1 AND revoked IS NOT TRUE
        ORDER BY last_seen DESC NULLS LAST
        LIMIT 1`,
      [row.id],
    );
    const connectorRow = connectorRows[0];
    const lastSeen = connectorRow?.last_seen;
    const connectorOnline =
      !!lastSeen && Date.now() - lastSeen.getTime() < 2 * 60 * 1000;
    if (!connectorOnline) {
      const tokenInfo = await createPairingTokenForHost({
        account_id: owner,
        host_id: row.id,
        ttlMs: 30 * 60 * 1000,
      });
      const { project_hosts_self_host_connector_version } =
        await getServerSettings();
      const connectorVersion =
        project_hosts_self_host_connector_version?.trim() || undefined;
      const { rows: metaRows } = await pool().query<{ metadata: any }>(
        `SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL`,
        [row.id],
      );
      const updatedMetadata = metaRows[0]?.metadata ?? metadata;
      const reversePort = Number(
        updatedMetadata?.self_host?.ssh_reverse_port ?? 0,
      );
      if (!reversePort) {
        throw new Error("self-host ssh reverse port missing");
      }
      await runConnectorInstallOverSsh({
        host_id: row.id,
        ssh_target: sshTarget,
        pairing_token: tokenInfo.token,
        name: row.name ?? undefined,
        ssh_port: reversePort,
        version: connectorVersion,
      });
    }
  }
  if (machineCloud === "self-host" && row.region && owner) {
    await ensureConnectorRecord({
      connector_id: row.region,
      account_id: owner,
      host_id: row.id,
      name: row.name ?? undefined,
    });
  }
  const { rows: metaRowsFinal } = await pool().query<{ metadata: any }>(
    `SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL`,
    [row.id],
  );
  const nextMetadata = metaRowsFinal[0]?.metadata ?? metadata;
  nextMetadata.desired_state = "running";
  if (nextMetadata?.self_host?.auto_start_pending) {
    const nextSelfHost = {
      ...(nextMetadata.self_host ?? {}),
      auto_start_pending: false,
      auto_start_cleared_at: new Date().toISOString(),
    };
    nextMetadata.self_host = nextSelfHost;
  }
  if (nextMetadata?.bootstrap) {
    delete nextMetadata.bootstrap;
  }
  if (machineCloud && machineCloud !== "self-host") {
    nextMetadata.bootstrap = {
      status: "queued",
      updated_at: new Date().toISOString(),
      message: "Waiting for cloud host bootstrap",
    };
  }
  logStatusUpdate(id, "starting", "api");
  await pool().query(
    `UPDATE project_hosts SET status=$2, last_seen=$3, metadata=$4, updated=NOW() WHERE id=$1 AND deleted IS NULL`,
    [id, "starting", null, nextMetadata],
  );
  if (!machineCloud) {
    logStatusUpdate(id, "running", "api");
    await pool().query(
      `UPDATE project_hosts SET status=$2, last_seen=$3, updated=NOW() WHERE id=$1 AND deleted IS NULL`,
      [id, "running", new Date()],
    );
  } else {
    await markHostActionPending(id, "start");
    await enqueueCloudVmWork({
      vm_id: id,
      action: "start",
      payload: { provider: machineCloud },
    });
  }
  const { rows } = await pool().query(
    `SELECT * FROM project_hosts WHERE id=$1 AND deleted IS NULL`,
    [id],
  );
  if (!rows[0]) throw new Error("host not found");
  return parseRow(rows[0]);
}

export async function stopHostInternalHelper({
  account_id,
  id,
  loadHostForStartStop,
  markHostActionPending,
  logStatusUpdate,
  parseRow,
}: {
  account_id?: string;
  id: string;
  loadHostForStartStop: (id: string, account_id?: string) => Promise<any>;
  markHostActionPending: (id: string, action: string) => Promise<void>;
  logStatusUpdate: (id: string, status: string, source: string) => void;
  parseRow: (row: any, opts?: any) => Host;
}): Promise<Host> {
  const row = await loadHostForStartStop(id, account_id);
  const metadata = row.metadata ?? {};
  const nextMetadata = { ...metadata, desired_state: "stopped" };
  const machine = metadata.machine ?? {};
  const machineCloud = normalizeProviderId(machine.cloud);
  logStatusUpdate(id, "stopping", "api");
  await pool().query(
    `UPDATE project_hosts SET status=$2, last_seen=$3, metadata=$4, updated=NOW() WHERE id=$1 AND deleted IS NULL`,
    [id, "stopping", null, nextMetadata],
  );
  if (!machineCloud) {
    logStatusUpdate(id, "off", "api");
    await pool().query(
      `UPDATE project_hosts SET status=$2, last_seen=$3, metadata=$4, updated=NOW() WHERE id=$1 AND deleted IS NULL`,
      [id, "off", null, nextMetadata],
    );
  } else {
    await markHostActionPending(id, "stop");
    await enqueueCloudVmWork({
      vm_id: id,
      action: "stop",
      payload: { provider: machineCloud },
    });
  }
  const { rows } = await pool().query(
    `SELECT * FROM project_hosts WHERE id=$1 AND deleted IS NULL`,
    [id],
  );
  if (!rows[0]) throw new Error("host not found");
  return parseRow(rows[0]);
}

export async function restartHostInternalHelper({
  account_id,
  id,
  mode,
  loadHostForStartStop,
  markHostActionPending,
  logStatusUpdate,
  parseRow,
}: {
  account_id?: string;
  id: string;
  mode?: "reboot" | "hard";
  loadHostForStartStop: (id: string, account_id?: string) => Promise<any>;
  markHostActionPending: (id: string, action: string) => Promise<void>;
  logStatusUpdate: (id: string, status: string, source: string) => void;
  parseRow: (row: any, opts?: any) => Host;
}): Promise<Host> {
  const row = await loadHostForStartStop(id, account_id);
  if (row.status === "deprovisioned") {
    throw new Error("host is not provisioned");
  }
  if (!["running", "error"].includes(row.status)) {
    throw new Error("host must be running to restart");
  }
  const metadata = row.metadata ?? {};
  metadata.desired_state = "running";
  const owner = metadata.owner ?? account_id;
  const machine = metadata.machine ?? {};
  const machineCloud = normalizeProviderId(machine.cloud);
  const provider = machineCloud ? getServerProvider(machineCloud) : undefined;
  const caps = provider?.entry.capabilities;
  const wantsHard = mode === "hard";
  if (machineCloud && caps) {
    const supported = wantsHard
      ? caps.supportsHardRestart
      : caps.supportsRestart;
    if (!supported) {
      throw new Error(
        wantsHard ? "hard reboot is not supported" : "reboot is not supported",
      );
    }
  }
  if (machineCloud === "self-host" && row.region && owner) {
    await ensureConnectorRecord({
      connector_id: row.region,
      account_id: owner,
      host_id: row.id,
      name: row.name ?? undefined,
    });
  }
  logStatusUpdate(id, "restarting", "api");
  await pool().query(
    `UPDATE project_hosts SET status=$2, last_seen=$3, metadata=$4, updated=NOW() WHERE id=$1 AND deleted IS NULL`,
    [id, "restarting", null, metadata],
  );
  if (!machineCloud) {
    logStatusUpdate(id, "running", "api");
    await pool().query(
      `UPDATE project_hosts SET status=$2, last_seen=$3, metadata=$4, updated=NOW() WHERE id=$1 AND deleted IS NULL`,
      [id, "running", new Date(), metadata],
    );
  } else {
    await markHostActionPending(
      id,
      mode === "hard" ? "hard_restart" : "restart",
    );
    await enqueueCloudVmWork({
      vm_id: id,
      action: mode === "hard" ? "hard_restart" : "restart",
      payload: { provider: machineCloud },
    });
  }
  const { rows } = await pool().query(
    `SELECT * FROM project_hosts WHERE id=$1 AND deleted IS NULL`,
    [id],
  );
  if (!rows[0]) throw new Error("host not found");
  return parseRow(rows[0]);
}
