/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { redux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { ComputeVm } from "@cocalc/conat/hub/api/compute";
import {
  readVmToolbox,
  VM_TOOLBOX_SETTING,
  vmToolboxAlias,
  vmToolboxContext,
} from "./vm-toolbox-model";
import type { VmToolboxBinding } from "./vm-toolbox-model";
import {
  projectSshConfigBlock,
  upsertProjectSshConfigBlock,
} from "@cocalc/frontend/project/settings/project-to-project-ssh-config";

export function currentVmToolbox() {
  return readVmToolbox(
    redux.getStore("account")?.get("other_settings")?.get(VM_TOOLBOX_SETTING),
  );
}

export function assertToolboxAccount(accountId: string) {
  if (redux.getStore("account")?.get("account_id") !== accountId) {
    throw Error("Account changed. Reopen the VM toolbox.");
  }
}

export async function saveVmToolbox(
  accountId: string,
  binding: VmToolboxBinding,
) {
  assertToolboxAccount(accountId);
  const records = currentVmToolbox().filter(
    (item) => item.agentId !== binding.agentId,
  );
  if (binding.vms.length) records.push(binding);
  if (records.length > 100)
    throw Error("VM toolbox limit reached (100 agents)");
  await redux
    .getActions("account")
    .set_other_settings_and_wait(VM_TOOLBOX_SETTING, JSON.stringify(records));
  assertToolboxAccount(accountId);
}

export async function listToolboxVms(projectId: string): Promise<ComputeVm[]> {
  const api = webapp_client.conat_client.hub.compute;
  const attached = await api.listProjectVms({ project_id: projectId });
  const owned = await api.listVms({});
  return [
    ...new Map(
      [...owned, ...attached]
        .filter((vm) => vm.state !== "deleted")
        .map((vm) => [vm.id, vm]),
    ).values(),
  ];
}

export async function prepareVmSsh(projectId: string, vmId: string) {
  const vm = await webapp_client.conat_client.hub.compute.getProjectVm({
    project_id: projectId,
    id_or_name: vmId,
  });
  const hostname = vm.public_hostname || vm.public_ip;
  const username = vm.ssh_user || "user";
  if (vm.state !== "ready" || !hostname) throw Error("VM is not ready for SSH");
  if (!/^[a-zA-Z0-9.-]+$/.test(hostname) || !/^[a-zA-Z0-9_-]+$/.test(username))
    throw Error("Invalid VM SSH endpoint");
  let existing = "";
  try {
    existing = await webapp_client.project_client.read_text_file({
      project_id: projectId,
      path: ".ssh/config",
    });
  } catch (err) {
    if (!/ENOENT|no such file|not found/i.test(String(err))) throw err;
  }
  const alias = vmToolboxAlias(vmId);
  const block = projectSshConfigBlock({
    alias,
    route: {
      transport: "direct",
      ssh_username: username,
      ssh_server: hostname,
      cloudflare_hostname: null,
    },
  });
  await webapp_client.project_client.write_text_file({
    project_id: projectId,
    path: ".ssh/config",
    content: upsertProjectSshConfigBlock({ content: existing, alias, block }),
  });
  await webapp_client.project_client.exec({
    project_id: projectId,
    command: "chmod",
    args: ["600", ".ssh/config"],
    timeout: 10,
  });
  await probeVmSsh(projectId, vmId);
}

export async function probeVmSsh(projectId: string, vmId: string) {
  await webapp_client.project_client.exec({
    project_id: projectId,
    command: "ssh",
    args: [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ConnectionAttempts=1",
      vmToolboxAlias(vmId),
      "true",
    ],
    timeout: 20,
    max_output: 2000,
  });
}

export async function contextForVmToolbox({
  accountId,
  projectId,
  path,
  threadId,
}: {
  accountId: string;
  projectId: string;
  path: string;
  threadId: string;
}): Promise<string> {
  const candidates = currentVmToolbox().filter(
    (item) =>
      item.projectId === projectId &&
      item.path === path &&
      item.threadId === threadId,
  );
  if (!candidates.length) return "";
  assertToolboxAccount(accountId);
  const identity = await webapp_client.conat_client.hub.agent.resolveIdentity({
    project_id: projectId,
    path,
    thread_id: threadId,
  });
  assertToolboxAccount(accountId);
  // Re-read preferences after asynchronous identity resolution (detach may race).
  const binding = currentVmToolbox().find(
    (item) =>
      item.agentId === identity?.agent_id &&
      item.projectId === projectId &&
      item.path === path &&
      item.threadId === threadId,
  );
  if (!binding?.vms.length) return "";
  const vms = await webapp_client.conat_client.hub.compute.listProjectVms({
    project_id: projectId,
  });
  assertToolboxAccount(accountId);
  const current = currentVmToolbox().find(
    (item) => item.agentId === binding.agentId,
  );
  const entries = current?.vms ?? [];
  return vmToolboxContext(
    entries,
    vms.map((vm) => ({
      vmId: vm.id,
      name: vm.name,
      state: vm.state,
      observedAt: new Date().toISOString(),
      deletesAt: vm.expires_at ? String(vm.expires_at) : undefined,
    })),
  );
}
