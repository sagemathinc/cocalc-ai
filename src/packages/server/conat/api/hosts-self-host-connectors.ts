/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Self-host connector operations for hosts.

What belongs here:

- explicit connector maintenance operations for self-hosted hosts
- ssh/reverse-tunnel based connector installation or upgrade flows once the
  caller has already resolved the host context

What does not belong here:

- broader host teardown / deprovision logic
- self-host provisioning embedded in create/start flows
- public LRO orchestration

This keeps the targeted connector-maintenance path separate from the larger
hosts API file.
*/

export async function upgradeHostConnectorInternalHelper({
  account_id,
  id,
  version,
  loadHostForStartStop,
  ensureSelfHostReverseTunnel,
  createPairingTokenForHost,
  getServerSettings,
  runConnectorInstallOverSsh,
}: {
  account_id?: string;
  id: string;
  version?: string;
  loadHostForStartStop: (id: string, account_id?: string) => Promise<any>;
  ensureSelfHostReverseTunnel: (opts: {
    host_id: string;
    ssh_target: string;
  }) => Promise<number | undefined>;
  createPairingTokenForHost: (opts: {
    account_id: string;
    host_id: string;
    ttlMs: number;
  }) => Promise<{ token: string }>;
  getServerSettings: () => Promise<{
    project_hosts_self_host_connector_version?: string | null;
  }>;
  runConnectorInstallOverSsh: (opts: {
    host_id: string;
    ssh_target: string;
    pairing_token: string;
    name?: string;
    ssh_port: number;
    version?: string;
  }) => Promise<void>;
}): Promise<void> {
  const row = await loadHostForStartStop(id, account_id);
  const metadata = row.metadata ?? {};
  const machine = metadata.machine ?? {};
  if (machine.cloud !== "self-host") {
    throw new Error("host is not self-hosted");
  }
  const sshTarget = String(machine.metadata?.self_host_ssh_target ?? "").trim();
  if (!sshTarget) {
    throw new Error("missing self-host ssh target");
  }
  const owner = metadata.owner ?? account_id;
  if (!owner) {
    throw new Error("missing host owner");
  }
  const reversePort = await ensureSelfHostReverseTunnel({
    host_id: row.id,
    ssh_target: sshTarget,
  });
  const tokenInfo = await createPairingTokenForHost({
    account_id: owner,
    host_id: row.id,
    ttlMs: 30 * 60 * 1000,
  });
  const { project_hosts_self_host_connector_version } =
    await getServerSettings();
  const connectorVersion =
    version?.trim() ||
    project_hosts_self_host_connector_version?.trim() ||
    undefined;
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
