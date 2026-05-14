/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  InterBayProjectSecretsApi,
  InterBayProjectSecretsExportResult,
} from "@cocalc/conat/inter-bay/api";
import type {
  CopyProjectSecretsResult,
  ProjectSecretMetadata,
} from "@cocalc/conat/hub/api/projects";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { publishProjectDetailInvalidationBestEffort } from "@cocalc/server/account/project-detail-feed";
import { assertLocalProjectCollaborator } from "@cocalc/server/conat/project-local-access";
import { getAssignedProjectHostInfo } from "@cocalc/server/conat/project-host-assignment";
import { resolveProjectBayDirect } from "@cocalc/server/inter-bay/directory";
import getLogger from "@cocalc/backend/logger";
import { getRoutedHostControlClient } from "@cocalc/server/project-host/client";
import {
  copyProjectSecrets,
  deleteProjectSecret,
  exportProjectSecretsForCopy,
  getProjectSecretsRuntimeCache,
  importProjectSecretsForCopy,
  listProjectSecrets,
  setProjectSecret,
} from "@cocalc/server/projects/project-secrets";
import { generateProjectSshKeySecretLocal } from "@cocalc/server/projects/project-secret-ssh-key";

const logger = getLogger("server:inter-bay:project-secrets");

async function assertCurrentProjectOwnership({
  project_id,
  epoch,
}: {
  project_id: string;
  epoch?: number;
}): Promise<void> {
  const ownership = await resolveProjectBayDirect(project_id);
  if (ownership == null) {
    throw new Error(`project ${project_id} not found`);
  }
  const currentBayId = getConfiguredBayId();
  if (
    ownership.bay_id !== currentBayId ||
    (epoch != null && ownership.epoch !== epoch)
  ) {
    throw new Error(
      `stale project secrets routing for ${project_id}: expected bay=${currentBayId}, epoch=${epoch}, actual bay=${ownership.bay_id}, epoch=${ownership.epoch}`,
    );
  }
}

async function assertLocalProjectSecretAccess({
  account_id,
  project_id,
  epoch,
}: {
  account_id: string;
  project_id: string;
  epoch?: number;
}): Promise<void> {
  await assertCurrentProjectOwnership({ project_id, epoch });
  await assertLocalProjectCollaborator({ account_id, project_id });
}

async function syncProjectSecretsCacheOnAssignedHost({
  project_id,
}: {
  project_id: string;
}): Promise<void> {
  let host_id: string;
  try {
    host_id = (await getAssignedProjectHostInfo(project_id)).host_id;
  } catch (err) {
    logger.debug("project secrets cache sync skipped; no assigned host", {
      project_id,
      err: `${err}`,
    });
    return;
  }
  try {
    const cache = await getProjectSecretsRuntimeCache({ project_id });
    const client = await getRoutedHostControlClient({
      host_id,
      timeout: 30_000,
    });
    await client.syncProjectSecretsCache({ project_id, cache });
  } catch (err) {
    logger.warn("project secrets cache sync to host failed", {
      project_id,
      host_id,
      err: `${err}`,
    });
  }
}

export async function handleProjectSecretsList({
  account_id,
  project_id,
  epoch,
}: Parameters<InterBayProjectSecretsApi["list"]>[0]): Promise<
  ProjectSecretMetadata[]
> {
  await assertLocalProjectSecretAccess({ account_id, project_id, epoch });
  return await listProjectSecrets({ project_id });
}

export async function handleProjectSecretsSet({
  account_id,
  project_id,
  name,
  value,
  epoch,
}: Parameters<
  InterBayProjectSecretsApi["set"]
>[0]): Promise<ProjectSecretMetadata> {
  await assertLocalProjectSecretAccess({ account_id, project_id, epoch });
  const result = await setProjectSecret({
    project_id,
    name,
    value,
    account_id,
  });
  await publishProjectDetailInvalidationBestEffort({
    project_id,
    fields: ["secrets"],
  });
  await syncProjectSecretsCacheOnAssignedHost({ project_id });
  return result;
}

export async function handleProjectSecretsDelete({
  account_id,
  project_id,
  name,
  epoch,
}: Parameters<InterBayProjectSecretsApi["delete"]>[0]): Promise<{
  deleted: boolean;
}> {
  await assertLocalProjectSecretAccess({ account_id, project_id, epoch });
  const deleted = await deleteProjectSecret({ project_id, name, account_id });
  await publishProjectDetailInvalidationBestEffort({
    project_id,
    fields: ["secrets"],
  });
  if (deleted) {
    await syncProjectSecretsCacheOnAssignedHost({ project_id });
  }
  return {
    deleted,
  };
}

export async function handleProjectSecretsCopy({
  account_id,
  source_project_id,
  target_project_id,
  names,
  overwrite,
  source_epoch,
  target_epoch,
}: Parameters<
  InterBayProjectSecretsApi["copy"]
>[0]): Promise<CopyProjectSecretsResult> {
  await assertLocalProjectSecretAccess({
    account_id,
    project_id: source_project_id,
    epoch: source_epoch,
  });
  await assertLocalProjectSecretAccess({
    account_id,
    project_id: target_project_id,
    epoch: target_epoch,
  });
  const result = await copyProjectSecrets({
    source_project_id,
    target_project_id,
    names,
    overwrite,
    account_id,
  });
  if (result.copied.length > 0) {
    await Promise.all([
      publishProjectDetailInvalidationBestEffort({
        project_id: source_project_id,
        fields: ["secrets"],
      }),
      publishProjectDetailInvalidationBestEffort({
        project_id: target_project_id,
        fields: ["secrets"],
      }),
    ]);
    await syncProjectSecretsCacheOnAssignedHost({
      project_id: target_project_id,
    });
  }
  return result;
}

export async function handleProjectSecretsExportForCopy({
  account_id,
  project_id,
  names,
  epoch,
}: Parameters<
  InterBayProjectSecretsApi["exportForCopy"]
>[0]): Promise<InterBayProjectSecretsExportResult> {
  await assertLocalProjectSecretAccess({ account_id, project_id, epoch });
  return await exportProjectSecretsForCopy({ project_id, names });
}

export async function handleProjectSecretsImportForCopy({
  account_id,
  project_id,
  secrets,
  overwrite,
  epoch,
}: Parameters<
  InterBayProjectSecretsApi["importForCopy"]
>[0]): Promise<CopyProjectSecretsResult> {
  await assertLocalProjectSecretAccess({ account_id, project_id, epoch });
  const result = await importProjectSecretsForCopy({
    project_id,
    secrets,
    overwrite,
    account_id,
  });
  if (result.copied.length > 0) {
    await publishProjectDetailInvalidationBestEffort({
      project_id,
      fields: ["secrets"],
    });
    await syncProjectSecretsCacheOnAssignedHost({ project_id });
  }
  return result;
}

export async function handleProjectSecretsGenerateSshKeySecret({
  account_id,
  project_id,
  secret_name,
  epoch,
}: Parameters<InterBayProjectSecretsApi["generateSshKeySecret"]>[0]): Promise<
  Awaited<ReturnType<InterBayProjectSecretsApi["generateSshKeySecret"]>>
> {
  await assertLocalProjectSecretAccess({ account_id, project_id, epoch });
  const result = await generateProjectSshKeySecretLocal({
    project_id,
    account_id,
    secret_name,
  });
  await publishProjectDetailInvalidationBestEffort({
    project_id,
    fields: ["secrets"],
  });
  return result;
}
