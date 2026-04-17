/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Host teardown and deprovision helpers.

What belongs here:

- helpers that mark a host as stopped or deprovisioned
- shared teardown cleanup for delete, force-deprovision, and self-host
  connector removal
- the side-effecting internal delete / force-deprovision / connector-removal
  flows once the caller has already resolved the host row

What does not belong here:

- public API handler entrypoints
- LRO creation
- host upgrade / rollout logic
- unrelated host editing operations

This keeps the destructive host lifecycle path separate from the rest of the
large hosts API implementation.
*/

import type { HostMachine } from "@cocalc/conat/hub/api/hosts";

export async function setHostDesiredStateInternal({
  id,
  desiredState,
  updateHostDesiredState,
}: {
  id: string;
  desiredState: "running" | "stopped";
  updateHostDesiredState: (
    id: string,
    desiredState: "running" | "stopped",
  ) => Promise<void>;
}): Promise<void> {
  await updateHostDesiredState(id, desiredState);
}

export async function markHostDeprovisionedInternal({
  row,
  action,
  logStatusUpdate,
  revokeProjectHostTokensForHost,
  hasCloudflareTunnel,
  deleteCloudflareTunnel,
  hasDns,
  deleteHostDns,
  logWarn,
  updateHostDeprovisionedRecord,
  clearProjectHostMetrics,
  logCloudVmEvent,
  normalizeProviderId,
}: {
  row: any;
  action: string;
  logStatusUpdate: (id: string, status: string, source: string) => void;
  revokeProjectHostTokensForHost: (
    host_id: string,
    opts: { purpose: "bootstrap" | "master-conat" },
  ) => Promise<void>;
  hasCloudflareTunnel: () => Promise<boolean>;
  deleteCloudflareTunnel: (opts: {
    host_id: string;
    tunnel: any;
  }) => Promise<void>;
  hasDns: () => Promise<boolean>;
  deleteHostDns: (opts: { record_id: any }) => Promise<void>;
  logWarn: (message: string, payload: Record<string, any>) => void;
  updateHostDeprovisionedRecord: (opts: {
    row: any;
    nextMetadata: any;
  }) => Promise<void>;
  clearProjectHostMetrics: (opts: { host_id: string }) => Promise<void>;
  logCloudVmEvent: (opts: {
    vm_id: string;
    action: string;
    status: string;
    provider: any;
    spec: HostMachine;
    runtime: any;
  }) => Promise<void>;
  normalizeProviderId: (provider: any) => string | undefined;
}): Promise<void> {
  const machine: HostMachine = row.metadata?.machine ?? {};
  const runtime = row.metadata?.runtime;
  const nextMetadata = { ...(row.metadata ?? {}) };
  nextMetadata.desired_state = "stopped";
  delete nextMetadata.runtime;
  delete nextMetadata.dns;
  delete nextMetadata.cloudflare_tunnel;
  delete nextMetadata.metrics;

  logStatusUpdate(row.id, "deprovisioned", "api");
  await revokeProjectHostTokensForHost(row.id, { purpose: "bootstrap" });
  await revokeProjectHostTokensForHost(row.id, { purpose: "master-conat" });
  try {
    if (await hasCloudflareTunnel()) {
      await deleteCloudflareTunnel({
        host_id: row.id,
        tunnel: row.metadata?.cloudflare_tunnel,
      });
    } else if (await hasDns()) {
      await deleteHostDns({ record_id: row.metadata?.dns?.record_id });
    }
  } catch (err) {
    logWarn("force deprovision cleanup failed", {
      err: `${err}`,
      host_id: row.id,
    });
  }

  await updateHostDeprovisionedRecord({
    row,
    nextMetadata,
  });
  await clearProjectHostMetrics({ host_id: row.id });
  await logCloudVmEvent({
    vm_id: row.id,
    action,
    status: "success",
    provider: normalizeProviderId(machine.cloud) ?? machine.cloud,
    spec: machine,
    runtime,
  });
}

export async function forceDeprovisionHostInternalHelper({
  account_id,
  id,
  loadOwnedHost,
  normalizeProviderId,
  markHostDeprovisionedInternal,
}: {
  account_id?: string;
  id: string;
  loadOwnedHost: (id: string, account_id?: string) => Promise<any>;
  normalizeProviderId: (provider: any) => string | undefined;
  markHostDeprovisionedInternal: (opts: {
    row: any;
    action: string;
  }) => Promise<void>;
}): Promise<void> {
  const row = await loadOwnedHost(id, account_id);
  const machineCloud = normalizeProviderId(row.metadata?.machine?.cloud);
  if (machineCloud !== "self-host") {
    throw new Error("force deprovision is only supported for self-hosted VMs");
  }
  await markHostDeprovisionedInternal({
    row,
    action: "force_deprovision",
  });
}

export async function removeSelfHostConnectorInternalHelper({
  account_id,
  id,
  loadOwnedHost,
  normalizeProviderId,
  markHostDeprovisionedInternal,
  revokeConnector,
}: {
  account_id?: string;
  id: string;
  loadOwnedHost: (id: string, account_id?: string) => Promise<any>;
  normalizeProviderId: (provider: any) => string | undefined;
  markHostDeprovisionedInternal: (opts: {
    row: any;
    action: string;
  }) => Promise<void>;
  revokeConnector: (opts: {
    connector_id: string;
    account_id?: string;
  }) => Promise<void>;
}): Promise<void> {
  const row = await loadOwnedHost(id, account_id);
  const machineCloud = normalizeProviderId(row.metadata?.machine?.cloud);
  if (machineCloud !== "self-host") {
    throw new Error("host is not self-hosted");
  }
  await markHostDeprovisionedInternal({
    row,
    action: "remove_connector",
  });
  const connectorId =
    row.region ??
    row.metadata?.machine?.metadata?.connector_id ??
    row.metadata?.machine?.metadata?.connectorId;
  if (typeof connectorId === "string" && connectorId) {
    await revokeConnector({
      connector_id: connectorId,
      account_id,
    });
  }
}

export async function deleteHostInternalHelper({
  account_id,
  id,
  loadOwnedHost,
  normalizeProviderId,
  setHostDesiredStateInternal,
  enqueueCloudVmWork,
  logStatusUpdate,
  markHostDeleted,
  markHostDeprovisioning,
  markHostStoppedDeprovisioned,
}: {
  account_id?: string;
  id: string;
  loadOwnedHost: (id: string, account_id?: string) => Promise<any>;
  normalizeProviderId: (provider: any) => string | undefined;
  setHostDesiredStateInternal: (opts: {
    id: string;
    desiredState: "running" | "stopped";
  }) => Promise<void>;
  enqueueCloudVmWork: (opts: {
    vm_id: string;
    action: "delete";
    payload: { provider: string };
  }) => Promise<void>;
  logStatusUpdate: (id: string, status: string, source: string) => void;
  markHostDeleted: (id: string) => Promise<void>;
  markHostDeprovisioning: (id: string) => Promise<void>;
  markHostStoppedDeprovisioned: (id: string) => Promise<void>;
}): Promise<void> {
  const row = await loadOwnedHost(id, account_id);
  const machineCloud = normalizeProviderId(row.metadata?.machine?.cloud);
  if (row.status === "deprovisioned") {
    await setHostDesiredStateInternal({ id, desiredState: "stopped" });
    await markHostDeleted(id);
    return;
  }
  if (machineCloud) {
    await setHostDesiredStateInternal({ id, desiredState: "stopped" });
    await enqueueCloudVmWork({
      vm_id: id,
      action: "delete",
      payload: { provider: machineCloud },
    });
    logStatusUpdate(id, "deprovisioning", "api");
    await markHostDeprovisioning(id);
    return;
  }
  logStatusUpdate(id, "deprovisioned", "api");
  await markHostStoppedDeprovisioned(id);
}
