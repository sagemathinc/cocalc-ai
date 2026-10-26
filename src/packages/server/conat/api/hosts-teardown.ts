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
import { removeHostSshKnownHostAlias } from "@cocalc/server/cloud/host-ssh-known-hosts";

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
  releaseHostContentDns,
  alertAdmin,
  logWarn,
  updateHostDeprovisionedRecord,
  markHostProjectsUnprovisioned,
  clearProjectHostMetrics,
  clearHostRuntimeDeployments,
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
  deleteHostDns: (opts: { record_id: any; name?: string }) => Promise<void>;
  // Removes the host's content-origin DNS (trust-free step 6); throws unless
  // it is gone.
  releaseHostContentDns: (row: any) => Promise<void>;
  // Surfaces a content DNS record left behind: if the cause is the token,
  // the sweeper can't remove it either.
  alertAdmin: (opts: { subject: string; body: string }) => Promise<void>;
  logWarn: (message: string, payload: Record<string, any>) => void;
  updateHostDeprovisionedRecord: (opts: {
    row: any;
    nextMetadata: any;
  }) => Promise<void>;
  markHostProjectsUnprovisioned: (host_id: string) => Promise<void>;
  clearProjectHostMetrics: (opts: { host_id: string }) => Promise<void>;
  clearHostRuntimeDeployments: (opts: { host_id: string }) => Promise<void>;
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
  delete nextMetadata.runtime_deployments;

  logStatusUpdate(row.id, "deprovisioned", "api");
  await revokeProjectHostTokensForHost(row.id, { purpose: "bootstrap" });
  await revokeProjectHostTokensForHost(row.id, { purpose: "master-conat" });
  await removeHostSshKnownHostAlias({
    host_id: row.id,
    reason: action,
  });
  // Content-origin DNS is removed whatever the route mode, and its record is
  // kept in the metadata unless removal succeeded, so it can be retried (the
  // sweeper also finds it: the host is no longer running at that address).
  try {
    await releaseHostContentDns(row);
    delete nextMetadata.content_dns;
  } catch (err) {
    logWarn("force deprovision content DNS cleanup failed", {
      err: `${err}`,
      host_id: row.id,
    });
    await alertAdmin({
      subject: `Project content DNS not removed for deprovisioned host ${row.name ?? row.id}`,
      body: [
        "Deprovisioning a project host could not remove its content-origin DNS record, which may now point at an address the host no longer has.",
        `host_id=${row.id}`,
        `record=${row.metadata?.content_dns?.name ?? "unknown"}`,
        `error=${err}`,
        "The sweeper retries every 15 minutes, but it can't if the cause is the content-domain Cloudflare token or zone access.",
        "Fix the token, or delete the record by hand in Cloudflare and then clear metadata.content_dns on the host row.",
      ].join("\n"),
    }).catch(() => {});
  }
  try {
    if (await hasCloudflareTunnel()) {
      await deleteCloudflareTunnel({
        host_id: row.id,
        tunnel: row.metadata?.cloudflare_tunnel,
      });
    } else if (await hasDns()) {
      await deleteHostDns({
        record_id: row.metadata?.dns?.record_id,
        name: row.metadata?.dns?.name,
      });
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
  await markHostProjectsUnprovisioned(row.id);
  await clearProjectHostMetrics({ host_id: row.id });
  await clearHostRuntimeDeployments({ host_id: row.id });
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
  closeHostBillingSession,
  markHostDeleted,
  markHostDeprovisioning,
  markHostStoppedDeprovisioned,
  markHostProjectsUnprovisioned,
  clearHostRuntimeDeployments,
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
  closeHostBillingSession: (row: any) => Promise<void>;
  markHostDeleted: (id: string) => Promise<void>;
  markHostDeprovisioning: (id: string) => Promise<void>;
  markHostStoppedDeprovisioned: (id: string) => Promise<void>;
  markHostProjectsUnprovisioned: (host_id: string) => Promise<void>;
  clearHostRuntimeDeployments: (opts: { host_id: string }) => Promise<void>;
}): Promise<void> {
  const row = await loadOwnedHost(id, account_id);
  const machineCloud = normalizeProviderId(row.metadata?.machine?.cloud);
  const managedCloud =
    machineCloud && machineCloud !== "self-host" && machineCloud !== "local";
  const hasProviderRuntime =
    !!`${row.metadata?.runtime?.instance_id ?? ""}`.trim();
  if (row.status === "deprovisioned" || (managedCloud && !hasProviderRuntime)) {
    await setHostDesiredStateInternal({ id, desiredState: "stopped" });
    await removeHostSshKnownHostAlias({
      host_id: id,
      reason: "delete",
    });
    await markHostProjectsUnprovisioned(id);
    // Never hide the host row from billing maintenance while its metered
    // purchase can still be open.
    await closeHostBillingSession(row);
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
  await removeHostSshKnownHostAlias({
    host_id: id,
    reason: "delete",
  });
  await markHostStoppedDeprovisioned(id);
  await markHostProjectsUnprovisioned(id);
  await clearHostRuntimeDeployments({ host_id: id });
}
