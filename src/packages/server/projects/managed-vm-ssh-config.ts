/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { projectApiClient } from "@cocalc/conat/project/api";
import { assertProjectCollaboratorAccessAllowRemote } from "@cocalc/server/conat/project-remote-access";
import { connectProjectHostClient } from "./exec";

interface ManagedVmProjectSystemApi {
  managedVmSshPublicKey: () => Promise<string | null>;
  readTextFileFromProject: (opts: { path: string }) => Promise<string>;
}

function normalizeManagedVmSshPublicKey(key: string | null): string | null {
  if (key == null) return null;
  const normalized = key.trim();
  if (!normalized) return null;
  if (
    normalized.length > 16_384 ||
    normalized.includes("\n") ||
    normalized.includes("\r")
  ) {
    throw new Error("project deploy public key is invalid");
  }
  return normalized;
}

function isUnknownManagedVmSshPublicKey(err: unknown): boolean {
  const message = `${(err as Error)?.message ?? err}`;
  return (
    message.includes("unknown function 'system.managedVmSshPublicKey'") ||
    message.includes("unknown function 'managedVmSshPublicKey'")
  );
}

function isMissingFile(err: unknown): boolean {
  return (
    (err as { code?: string })?.code === "ENOENT" ||
    /ENOENT|no such file or directory/i.test(
      `${(err as Error)?.message ?? err}`,
    )
  );
}

export async function readManagedVmProjectSshPublicKey(
  system: ManagedVmProjectSystemApi,
): Promise<string | null> {
  try {
    return normalizeManagedVmSshPublicKey(await system.managedVmSshPublicKey());
  } catch (err) {
    if (!isUnknownManagedVmSshPublicKey(err)) throw err;
  }

  // Projects already running during this release expose the generic file RPC,
  // but not the dedicated managed-VM RPC until their next restart.
  try {
    return normalizeManagedVmSshPublicKey(
      await system.readTextFileFromProject({
        path: ".ssh/id_ed25519.pub",
      }),
    );
  } catch (err) {
    if (isMissingFile(err)) return null;
    throw err;
  }
}

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
    return await readManagedVmProjectSshPublicKey(api.system);
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
