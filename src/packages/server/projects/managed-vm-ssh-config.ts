/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { projectApiClient } from "@cocalc/conat/project/api";
import { assertProjectCollaboratorAccessAllowRemote } from "@cocalc/server/conat/project-remote-access";
import { connectProjectHostClient } from "./exec";

async function managedVmProjectClient(opts: {
  account_id: string;
  project_id: string;
}) {
  const project = await assertProjectCollaboratorAccessAllowRemote(opts);
  if (!project.host_id) {
    throw new Error(`project ${opts.project_id} has no assigned host`);
  }
  const client = await connectProjectHostClient({
    account_id: opts.account_id,
    host_id: project.host_id,
    project_id: opts.project_id,
  });
  return {
    client,
    api: projectApiClient({
      client,
      project_id: opts.project_id,
      timeout: 30_000,
    }),
  };
}

export async function getManagedVmProjectSshPublicKey(opts: {
  account_id: string;
  project_id: string;
}): Promise<string | null> {
  const { client, api } = await managedVmProjectClient(opts);
  try {
    return await api.system.managedVmSshPublicKey();
  } finally {
    client.close();
  }
}

export async function syncManagedVmProjectSshConfig(opts: {
  account_id: string;
  project_id: string;
  vm_id: string;
  vm_name: string;
  hostname: string;
  enabled: boolean;
}): Promise<{ alias: string; changed: boolean }> {
  const { client, api } = await managedVmProjectClient(opts);
  try {
    return await api.system.syncManagedVmSshConfig({
      vm_id: opts.vm_id,
      vm_name: opts.vm_name,
      hostname: opts.hostname,
      enabled: opts.enabled,
    });
  } finally {
    client.close();
  }
}
