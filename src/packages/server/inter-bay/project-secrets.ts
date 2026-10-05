/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  InterBayProjectSecretsApi,
  InterBayProjectSecretsExportResult,
} from "@cocalc/conat/inter-bay/api";
import type { CopyProjectSecretsResult } from "@cocalc/conat/hub/api/projects";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { publishProjectDetailInvalidationBestEffort } from "@cocalc/server/account/project-detail-feed";
import { assertLocalProjectCollaborator } from "@cocalc/server/conat/project-local-access";
import { resolveProjectBayDirect } from "@cocalc/server/inter-bay/directory";
import {
  copyProjectSecrets,
  exportProjectSecretsForCopy,
  installCourseManagedProjectSecrets,
  importProjectSecretsForCopy,
  listCourseShareableSecrets,
  removeCourseManagedProjectSecrets,
  setProjectSecretCourseSharing,
  validateCourseSecretTargetAssociation,
} from "@cocalc/server/projects/project-secrets";
import {
  getCourseSecretPolicyState,
  getCourseSecretRunStatus,
  revokeCourseSecretPolicy,
  revokeCourseSecretRecipients,
  setCourseSecretGrants,
  setCourseSecretPolicyEnabled,
} from "@cocalc/server/projects/course-secret-sharing";
import {
  approveCourseSecretRecipientsLocal,
  previewCourseSecretSyncLocal,
  startCourseSecretRunLocal,
} from "@cocalc/server/projects/course-secret-sharing-coordinator";
import { syncProjectSecretsRuntimeOnAssignedHost } from "@cocalc/server/projects/project-secrets-runtime";
import { requireDangerousProjectMutationAuth } from "@cocalc/server/conat/api/project-dangerous-auth";

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

async function assertFreshCourseMutation(
  account_id: string,
  session_hash?: string | null,
): Promise<void> {
  await requireDangerousProjectMutationAuth({ account_id, session_hash });
}

export async function handleProjectSecretsValidateCourseTarget({
  project_id,
  course_project_id,
  course_path,
  epoch,
}: Parameters<InterBayProjectSecretsApi["validateCourseTarget"]>[0]) {
  await assertCurrentProjectOwnership({ project_id, epoch });
  const reason = await validateCourseSecretTargetAssociation({
    project_id,
    course_project_id,
    course_path,
  });
  return { eligible: reason === "eligible", reason };
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
    result.runtime_refresh = await syncProjectSecretsRuntimeOnAssignedHost({
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
    result.runtime_refresh = await syncProjectSecretsRuntimeOnAssignedHost({
      project_id,
    });
  }
  return result;
}

export async function handleProjectSecretsListCourseShareable({
  account_id,
  course_project_id,
  epoch,
}: Parameters<InterBayProjectSecretsApi["listCourseShareable"]>[0]) {
  await assertLocalProjectSecretAccess({
    account_id,
    project_id: course_project_id,
    epoch,
  });
  return await listCourseShareableSecrets({ project_id: course_project_id });
}

export async function handleProjectSecretsGetCoursePolicy({
  account_id,
  course_project_id,
  course_id,
  course_path,
  epoch,
}: Parameters<InterBayProjectSecretsApi["getCoursePolicy"]>[0]) {
  await assertLocalProjectSecretAccess({
    account_id,
    project_id: course_project_id,
    epoch,
  });
  return await getCourseSecretPolicyState({
    course_project_id,
    course_id,
    course_path,
  });
}

export async function handleProjectSecretsPreviewCourseSync({
  account_id,
  course_project_id,
  course_id,
  course_path,
  target_project_ids,
  epoch,
}: Parameters<InterBayProjectSecretsApi["previewCourseSync"]>[0]) {
  await assertLocalProjectSecretAccess({
    account_id,
    project_id: course_project_id,
    epoch,
  });
  return await previewCourseSecretSyncLocal({
    course_project_id,
    course_id,
    course_path,
    target_project_ids,
  });
}

export async function handleProjectSecretsSetCourseSharing({
  account_id,
  session_hash,
  project_id,
  name,
  allow,
  epoch,
}: Parameters<InterBayProjectSecretsApi["setCourseSharing"]>[0]) {
  await assertFreshCourseMutation(account_id, session_hash);
  await assertLocalProjectSecretAccess({ account_id, project_id, epoch });
  const result = await setProjectSecretCourseSharing({
    project_id,
    name,
    allow,
    account_id,
  });
  await publishProjectDetailInvalidationBestEffort({
    project_id,
    fields: ["secrets"],
  });
  return result;
}

export async function handleProjectSecretsSetCoursePolicy({
  account_id,
  session_hash,
  course_project_id,
  course_id,
  course_path,
  enabled,
  epoch,
}: Parameters<InterBayProjectSecretsApi["setCoursePolicy"]>[0]) {
  await assertFreshCourseMutation(account_id, session_hash);
  await assertLocalProjectSecretAccess({
    account_id,
    project_id: course_project_id,
    epoch,
  });
  return await setCourseSecretPolicyEnabled({
    course_project_id,
    course_id,
    course_path,
    enabled,
    account_id,
  });
}

export async function handleProjectSecretsSetCourseGrants({
  account_id,
  session_hash,
  course_project_id,
  course_id,
  course_path,
  names,
  epoch,
}: Parameters<InterBayProjectSecretsApi["setCourseGrants"]>[0]) {
  await assertFreshCourseMutation(account_id, session_hash);
  await assertLocalProjectSecretAccess({
    account_id,
    project_id: course_project_id,
    epoch,
  });
  return await setCourseSecretGrants({
    course_project_id,
    course_id,
    course_path,
    names,
    account_id,
  });
}

export async function handleProjectSecretsApproveCourseRecipients({
  account_id,
  session_hash,
  course_project_id,
  course_id,
  course_path,
  recipients,
  epoch,
}: Parameters<InterBayProjectSecretsApi["approveCourseRecipients"]>[0]) {
  await assertFreshCourseMutation(account_id, session_hash);
  await assertLocalProjectSecretAccess({
    account_id,
    project_id: course_project_id,
    epoch,
  });
  return await approveCourseSecretRecipientsLocal({
    account_id,
    course_project_id,
    course_id,
    course_path,
    recipients,
  });
}

export async function handleProjectSecretsRevokeCourseRecipients({
  account_id,
  session_hash,
  course_project_id,
  course_id,
  course_path,
  target_project_ids,
  epoch,
}: Parameters<InterBayProjectSecretsApi["revokeCourseRecipients"]>[0]) {
  await assertFreshCourseMutation(account_id, session_hash);
  await assertLocalProjectSecretAccess({
    account_id,
    project_id: course_project_id,
    epoch,
  });
  return await revokeCourseSecretRecipients({
    account_id,
    course_project_id,
    course_id,
    course_path,
    target_project_ids,
  });
}

export async function handleProjectSecretsStartCourseSync(
  opts: Parameters<InterBayProjectSecretsApi["startCourseSync"]>[0],
) {
  await assertFreshCourseMutation(opts.account_id, opts.session_hash);
  await assertLocalProjectSecretAccess({
    account_id: opts.account_id,
    project_id: opts.course_project_id,
    epoch: opts.epoch,
  });
  return await startCourseSecretRunLocal({ ...opts, mode: "sync" });
}

export async function handleProjectSecretsStartCourseCleanup(
  opts: Parameters<InterBayProjectSecretsApi["startCourseCleanup"]>[0],
) {
  await assertFreshCourseMutation(opts.account_id, opts.session_hash);
  await assertLocalProjectSecretAccess({
    account_id: opts.account_id,
    project_id: opts.course_project_id,
    epoch: opts.epoch,
  });
  return await startCourseSecretRunLocal({ ...opts, mode: "cleanup" });
}

export async function handleProjectSecretsGetCourseSyncStatus({
  account_id,
  course_project_id,
  course_id,
  run_id,
  epoch,
}: Parameters<InterBayProjectSecretsApi["getCourseSyncStatus"]>[0]) {
  await assertLocalProjectSecretAccess({
    account_id,
    project_id: course_project_id,
    epoch,
  });
  return await getCourseSecretRunStatus({
    course_project_id,
    course_id,
    run_id,
  });
}

export async function handleProjectSecretsRevokeCoursePolicy({
  account_id,
  session_hash,
  course_project_id,
  course_id,
  course_path,
  epoch,
}: Parameters<InterBayProjectSecretsApi["revokeCoursePolicy"]>[0]) {
  await assertFreshCourseMutation(account_id, session_hash);
  await assertLocalProjectSecretAccess({
    account_id,
    project_id: course_project_id,
    epoch,
  });
  return await revokeCourseSecretPolicy({
    account_id,
    course_project_id,
    course_id,
    course_path,
  });
}

export async function handleProjectSecretsInstallCourseManaged({
  epoch,
  ...opts
}: Parameters<InterBayProjectSecretsApi["installCourseManaged"]>[0]) {
  await assertCurrentProjectOwnership({ project_id: opts.project_id, epoch });
  const result = await installCourseManagedProjectSecrets(opts);
  await publishProjectDetailInvalidationBestEffort({
    project_id: opts.project_id,
    fields: ["secrets"],
  });
  const runtime_refresh = await syncProjectSecretsRuntimeOnAssignedHost({
    project_id: opts.project_id,
  });
  return { ...result, runtime_refresh };
}

export async function handleProjectSecretsRemoveCourseManaged({
  epoch,
  ...opts
}: Parameters<InterBayProjectSecretsApi["removeCourseManaged"]>[0]) {
  await assertCurrentProjectOwnership({ project_id: opts.project_id, epoch });
  const result = await removeCourseManagedProjectSecrets(opts);
  await publishProjectDetailInvalidationBestEffort({
    project_id: opts.project_id,
    fields: ["secrets"],
  });
  const runtime_refresh = await syncProjectSecretsRuntimeOnAssignedHost({
    project_id: opts.project_id,
  });
  return { ...result, runtime_refresh };
}
