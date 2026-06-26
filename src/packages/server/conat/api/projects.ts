import { randomUUID } from "node:crypto";
import createProject from "@cocalc/server/projects/create";
export { createProject };
import execProject from "@cocalc/server/projects/exec";
import { takeStartProjectPhaseTimings } from "@cocalc/server/project-host/control";
import {
  assertHardDeleteProjectPermission,
  assertProjectDeletionProtectionDisabled,
} from "@cocalc/server/projects/hard-delete";
import { assertProjectHardDeleteAdmission } from "@cocalc/server/projects/hard-delete-admission";
import {
  assertProjectNotHardDeleting,
  markProjectHardDeleteAccepted,
} from "@cocalc/server/projects/hard-delete-state";
import getLogger from "@cocalc/backend/logger";
import isAdmin from "@cocalc/server/accounts/is-admin";
export * from "@cocalc/server/projects/collaborators";
import {
  createCollabInvite as createCollabInviteLocal,
  copyEmailProjectInviteLink as copyEmailProjectInviteLinkLocal,
  getProjectAccessLandingInfo as getProjectAccessLandingInfoLocal,
  hashProjectCollabInviteToken,
  inviteCollaboratorWithoutAccount as inviteCollaboratorWithoutAccountLocal,
  previewEmailProjectInvite as previewEmailProjectInviteLocal,
  listProjectAccessRequestBlocks as listProjectAccessRequestBlocksLocal,
  listProjectAccessRequests as listProjectAccessRequestsLocal,
  listCollaborators as listCollaboratorsLocal,
  listCollabInvites as listCollabInvitesLocal,
  redeemEmailProjectInvite as redeemEmailProjectInviteLocal,
  requestProjectAccess as requestProjectAccessLocal,
  respondEmailProjectInvite as respondEmailProjectInviteLocal,
  removeCollaborator as removeCollaboratorLocal,
  repairAcceptedCourseStudentInviteAccountsLocal,
  respondCollabInvite as respondCollabInviteLocal,
  respondProjectAccessRequest as respondProjectAccessRequestLocal,
  setProjectUserRole as setProjectUserRoleLocal,
  unblockProjectAccessRequester as unblockProjectAccessRequesterLocal,
} from "@cocalc/server/projects/collaborators";
import { ensureCourseManagerAccessLocal } from "@cocalc/server/projects/course/ensure-manager-access";
import {
  leaveOrDeleteProjectsForAccount,
  type ProjectLeaveOrDeleteResult,
} from "@cocalc/server/projects/ownership";
import { type CopyOptions } from "@cocalc/conat/files/fs";
export * from "@cocalc/server/conat/api/project-snapshots";
export * from "@cocalc/server/conat/api/project-backups";
import getPool from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { updateAuthorizedKeysOnHost as updateAuthorizedKeysOnHostControl } from "@cocalc/server/project-host/control";
import { supersedeOlderProjectStartLros } from "@cocalc/server/projects/start-lro-cleanup";
import { getExplicitProjectRoutedClient } from "@cocalc/server/conat/route-client";
import { getProjectFileServerClient } from "@cocalc/server/conat/file-server-client";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveProjectCollabInviteDirectory } from "@cocalc/server/projects/collab-invite-directory";
import { resolveOnPremHost } from "@cocalc/server/onprem";
import { posix } from "path";
import type {
  ExecuteCodeOptions,
  ExecuteCodeOutput,
} from "@cocalc/util/types/execute-code";
import {
  extractProjectIdFromPublicViewerRawUrl,
  parsePublicViewerImportUrl,
} from "@cocalc/util/public-viewer-import";
import {
  isAllowedPublicViewerSourceHost,
  resolvePublicViewerDns,
} from "@cocalc/util/public-viewer-origin";
import { isValidUUID } from "@cocalc/util/misc";
import type { CodexUsageStatusInfo } from "@cocalc/conat/hub/api/system";
import {
  cancelCopy as cancelCopyDb,
  listCopiesByOpId,
  listCopiesForProject,
} from "@cocalc/server/projects/copy-db";
import { triggerCopyLroWorker } from "@cocalc/server/projects/copy-worker";
import {
  COURSE_COLLECT_ASSIGNMENT_LRO_KIND,
  courseCollectLroResponse,
  triggerCourseCollectLroWorker,
} from "@cocalc/server/projects/course-collect-worker";
import { createLro, getLro, updateLro } from "@cocalc/server/lro/lro-db";
import { publishLroEvent, publishLroSummary } from "@cocalc/server/lro/stream";
import { lroStreamName } from "@cocalc/conat/lro/names";
import { SERVICE as PERSIST_SERVICE } from "@cocalc/conat/persist/util";
import { getBackups } from "@cocalc/conat/project/archive-info";
import {
  makeOfflineMoveConfirmationPayload,
  offlineMoveConfirmationError,
} from "@cocalc/server/projects/offline-move-confirmation";
import {
  assertCanIncreaseAccountStorage,
  getProjectCollaboratorInviteUsage as getProjectCollaboratorInviteUsageLocal,
  getProjectOwnerAccountId,
} from "@cocalc/server/membership/project-limits";
import { assertCanPerformDestructiveStorageAction } from "@cocalc/server/projects/destructive-storage-actions";
import {
  drainProjectRehome as drainProjectRehomeControl,
  getProjectRehomeOperation as getProjectRehomeOperationControl,
  reconcileProjectRehome as reconcileProjectRehomeControl,
  rehomeProject as rehomeProjectControl,
} from "@cocalc/server/projects/rehome";
import type { LroSummary } from "@cocalc/conat/hub/api/lro";
import type {
  ProjectRehomeOperationSummary,
  ProjectRehomeResponse,
} from "@cocalc/conat/hub/api/projects";
import type { ManagedProjectEgressOverride } from "@cocalc/conat/files/file-server";
import { assertCollab, assertCollabAllowRemoteProjectAccess } from "./util";
import {
  getLocalProjectCollaboratorAccessStatus,
  PROJECT_COLLABORATOR_REQUIRED_ERROR,
  PROJECT_NOT_FOUND_ERROR,
} from "@cocalc/server/conat/project-local-access";
import { resolveProjectAccessAllowRemote } from "@cocalc/server/conat/project-remote-access";
import type { ProjectViewerReadPolicy } from "@cocalc/util/project-access";
import type {
  ChatStoreScope,
  CourseAssignmentPatchDestination,
  CourseAssignmentPatchResult,
  CourseStudentAccessStatus,
  CourseCollectAssignmentItem,
  CourseCollectAssignmentResult,
  ImportPublicUrlResult,
  ImportPublicPathResult,
  PublicPathInspectionResult,
  AccountRuntimeSponsorStatus,
  AccountProjectListWindowRow,
  AccountProjectListWindowSort,
  ProjectActiveOperationSummary,
  ProjectCopyDestination,
  ProjectCopyRow,
  ProjectRuntimeSponsorActiveProject,
  ProjectRuntimeLog,
  ProjectHiddenResult,
  ProjectRuntimeSponsorStatus,
  ProjectAddress,
  ProjectRegion,
  ProjectCreated,
  ProjectEnv,
  ProjectSecretMetadata,
  CopyProjectSecretsResult,
  GenerateProjectSshKeySecretResult,
  ProjectCourseInfo,
  ProjectRootfsConfig,
  ProjectRootfsBuildCancelRequest,
  ProjectRootfsBuildCancelResponse,
  ProjectRootfsBuildLogRequest,
  ProjectRootfsBuildLogResponse,
  ProjectRootfsBuildListRequest,
  ProjectRootfsBuildPublishRecordRequest,
  ProjectRootfsBuildPublishRecordResponse,
  ProjectRootfsBuildRecord,
  ProjectRootfsBuildStartRequest,
  ProjectRootfsBuildStatusRequest,
  ProjectRootfsBuildStatusResponse,
  ProjectRootfsPublishConfig,
  ProjectLabelPatch,
  ProjectLabels,
  ProjectSnapshotSchedule,
  ProjectBackupSchedule,
  CourseManagerAccessResult,
  CourseStudentInviteAccountRepairInput,
  CourseStudentInviteAccountRepairRow,
  ProjectCollabInviteAction,
  ProjectCollabInviteDirection,
  ProjectCollabInviteStatus,
  ProjectCopySource,
  ProjectInviteEmailBlockedReason,
  ProjectRunQuota,
  WorkspaceSshConnectionInfo,
} from "@cocalc/conat/hub/api/projects";
import { listProjectedProjectsForAccount } from "@cocalc/database/postgres/account-project-index";
import { validateProjectEnv } from "@cocalc/util/project-secrets";
import { parseRootfsConfigExport } from "@cocalc/util/rootfs-images";
import {
  copyProjectSecrets as copyProjectSecretsInDb,
  deleteProjectSecret as deleteProjectSecretInDb,
  exportProjectSecretsForCopy,
  importProjectSecretsForCopy,
  listProjectSecrets as listProjectSecretsInDb,
  getProjectSecretsRuntimeCache,
  setProjectSecret as setProjectSecretInDb,
} from "@cocalc/server/projects/project-secrets";
import { generateProjectSshKeySecretLocal } from "@cocalc/server/projects/project-secret-ssh-key";
import { resolveMembershipForAccount } from "@cocalc/server/membership/resolve";
import { getSeedMembershipTierById } from "@cocalc/server/membership/tiers";
import {
  assignMembershipPackageSeat,
  listClaimableMembershipPackagesForAccount,
  listMembershipPackageDetailsForOwner,
} from "@cocalc/server/membership/packages";
import {
  deleteProjectSshKeyInDb,
  upsertProjectSshKeyInDb,
} from "@cocalc/server/projects/project-ssh-keys";
import {
  getProjectLabels as getProjectLabelsInDb,
  setProjectLabels as setProjectLabelsInDb,
} from "@cocalc/server/projects/labels";
import {
  getAssignedProjectHostInfo,
  PROJECT_HAS_NO_ASSIGNED_HOST_ERROR,
} from "@cocalc/server/conat/project-host-assignment";
import { appendProjectOutboxEventForProject } from "@cocalc/database/postgres/project-events-outbox";
import {
  assertProjectNotRehoming,
  withProjectRehomeWriteFence,
} from "@cocalc/database/postgres/project-rehome-fence";
import { publishProjectAccountFeedEventsBestEffort } from "@cocalc/server/account/project-feed";
import { publishProjectDetailInvalidationBestEffort } from "@cocalc/server/account/project-detail-feed";
import { getRoutedHostControlClient } from "@cocalc/server/project-host/client";
import {
  createProjectRootfsBuildLro,
  getProjectRootfsBuildRecord,
  listProjectRootfsBuildRecords,
  markProjectRootfsBuildFailed,
  recordProjectRootfsBuildPublish as recordProjectRootfsBuildPublishInDb,
  syncProjectRootfsBuildLro,
  upsertProjectRootfsBuildStatus,
} from "@cocalc/server/rootfs/build-index";
import { loadProjectReadDetailsDirect } from "@cocalc/server/projects/details";
import { fromWire as collabInviteFromWire } from "@cocalc/server/projects/collab-invite-inbox";
import {
  deleteProjectDataOnHost,
  savePlacement,
} from "@cocalc/server/project-host/control";
import { assertAccountTrustedForProductAccess } from "@cocalc/server/accounts/trusted-product-access";
import getName from "@cocalc/server/accounts/get-name";
import { resolveProjectOwningBay } from "@cocalc/server/bay-directory";
import dayjs from "dayjs";
import {
  PROJECT_DANGEROUS_INTERNAL_AUTH,
  requireDangerousProjectMutationAuth,
} from "./project-dangerous-auth";
import { resolveHostConnection } from "./hosts";
export { PROJECT_DANGEROUS_INTERNAL_AUTH };
import {
  assertCanStartUsingRuntimeSponsor,
  loadProjectRuntimeSponsor,
} from "@cocalc/server/projects/runtime-sponsor-db";
import {
  listProjectRuntimeSlots,
  type ProjectRuntimeSlot,
  releaseProjectRuntimeSlot,
  reserveProjectRuntimeSlot,
} from "@cocalc/server/projects/runtime-slots";
import { getEffectiveMembershipUsageLimits } from "@cocalc/server/membership/effective-limits";
import {
  encodeRuntimeSponsorDenial,
  extractRuntimeSponsorDenial,
  formatRuntimeSponsorDenial,
  type RuntimeSponsorDenial,
} from "@cocalc/util/runtime-sponsor-denial";

// Ordinary starts should fail fast enough that stale runtime slots and active
// operations do not block scale tests for hours. Explicit backup restores can
// legitimately take much longer.
const ORDINARY_PROJECT_START_CONTROL_TIMEOUT_MS = 10 * 60 * 1000;
const RESTORE_PROJECT_START_CONTROL_TIMEOUT_MS = 8 * 60 * 60 * 1000;
const PROJECT_MOVE_RUNTIME_SLOT_TTL_MS = 8 * 60 * 60 * 1000;
const ACCOUNT_PROJECT_LIST_WINDOW_MAX_LIMIT = 500;

function projectStartControlTimeoutMs({
  restore_backup_id,
}: {
  restore_backup_id?: string;
}): number {
  return restore_backup_id
    ? RESTORE_PROJECT_START_CONTROL_TIMEOUT_MS
    : ORDINARY_PROJECT_START_CONTROL_TIMEOUT_MS;
}

async function enrichRuntimeSponsorDenial({
  denial,
  account_id,
}: {
  denial: RuntimeSponsorDenial;
  account_id: string;
}): Promise<RuntimeSponsorDenial> {
  const sponsor_display_name = await getName(denial.sponsor_account_id).catch(
    () => undefined,
  );
  const active_projects = await Promise.all(
    denial.active_projects.map(async (project) => {
      try {
        const reference = await resolveProjectOwningBay({
          account_id,
          project_id: project.project_id,
        });
        return {
          ...project,
          title: reference.title || undefined,
          visible: true,
          can_stop: true,
        };
      } catch {
        return {
          project_id: project.project_id,
          state: project.state,
          visible: false,
          can_stop: false,
        };
      }
    }),
  );
  return {
    ...denial,
    ...(sponsor_display_name ? { sponsor_display_name } : {}),
    can_upgrade: account_id === denial.sponsor_account_id,
    can_change_sponsor: account_id !== denial.sponsor_account_id,
    active_projects,
  };
}

async function runtimeSponsorActiveProjectsForViewer({
  account_id,
  slots,
}: {
  account_id: string;
  slots: ProjectRuntimeSlot[];
}): Promise<ProjectRuntimeSponsorActiveProject[]> {
  return await Promise.all(
    slots.map(async (slot) => {
      const state: "starting" | "running" =
        slot.state === "starting" ? "starting" : "running";
      try {
        const reference = await resolveProjectOwningBay({
          account_id,
          project_id: slot.project_id,
        });
        return {
          project_id: slot.project_id,
          title: reference.title || undefined,
          state,
          visible: true,
          can_stop: true,
        };
      } catch {
        return {
          project_id: slot.project_id,
          state,
          visible: false,
          can_stop: false,
        };
      }
    }),
  );
}

async function projectFs(project_id: string) {
  return (await getExplicitProjectRoutedClient({ project_id })).fs({
    project_id,
  });
}

async function authorizeCopySource({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<ProjectViewerReadPolicy | undefined> {
  const access = await resolveProjectAccessAllowRemote({
    account_id,
    project_id,
  });
  if (access.capabilities.writeProjectFiles) {
    await assertCollab({ account_id, project_id });
    return;
  }
  if (access.role === "viewer" && access.read_policy) {
    return access.read_policy;
  }
  throw new Error("user must be a collaborator or viewer on source project");
}

export async function copyPathBetweenProjects({
  src,
  src_home,
  dest,
  dests,
  options,
  account_id,
}: {
  src: ProjectCopySource;
  src_home?: string;
  dest?: ProjectCopyDestination;
  dests?: ProjectCopyDestination[];
  options?: CopyOptions;
  account_id?: string;
}): Promise<{
  op_id: string;
  scope_type: "project";
  scope_id: string;
  service: string;
  stream_name: string;
}> {
  if (!account_id) {
    throw Error("user must be signed in");
  }
  const normalizedDests = normalizeCopyDests({ dest, dests });
  const src_read_policy = await authorizeCopySource({
    account_id,
    project_id: src.project_id,
  });
  const authorizedCollabProjectIds = new Set<string>();
  if (!src_read_policy) {
    authorizedCollabProjectIds.add(src.project_id);
  }
  const destProjectIds = Array.from(
    new Set(normalizedDests.map((dest) => dest.project_id)),
  );
  for (const project_id of destProjectIds) {
    if (!authorizedCollabProjectIds.has(project_id)) {
      await assertCollab({ account_id, project_id });
      authorizedCollabProjectIds.add(project_id);
    }
  }
  const destOwnerAccountIds = new Set<string>();
  for (const project_id of destProjectIds) {
    const destOwnerAccountId = await getProjectOwnerAccountId(project_id);
    if (destOwnerAccountId) {
      destOwnerAccountIds.add(destOwnerAccountId);
    }
  }
  for (const ownerAccountId of destOwnerAccountIds) {
    await assertCanIncreaseAccountStorage({
      account_id: ownerAccountId,
    });
  }
  const op = await createLro({
    kind: "copy-path-between-projects",
    scope_type: "project",
    scope_id: src.project_id,
    created_by: account_id,
    routing: "hub",
    input: {
      src,
      ...(src_read_policy ? { src_read_policy } : {}),
      ...(src_home ? { src_home } : {}),
      dests: normalizedDests,
      options,
    },
    status: "queued",
  });
  try {
    await publishLroSummary({
      scope_type: op.scope_type,
      scope_id: op.scope_id,
      summary: op,
    });
  } catch (err) {
    log.warn("copyPathBetweenProjects: unable to publish initial LRO summary", {
      op_id: op.op_id,
      project_id: src.project_id,
      err,
    });
  }
  publishLroEvent({
    scope_type: op.scope_type,
    scope_id: op.scope_id,
    op_id: op.op_id,
    event: {
      type: "progress",
      ts: Date.now(),
      phase: "queued",
      message: "queued",
      progress: 0,
    },
  }).catch((err) => {
    log.warn(
      "copyPathBetweenProjects: unable to publish queued progress event",
      {
        op_id: op.op_id,
        project_id: src.project_id,
        err,
      },
    );
  });
  triggerCopyLroWorker();
  return {
    op_id: op.op_id,
    scope_type: "project",
    scope_id: src.project_id,
    service: PERSIST_SERVICE,
    stream_name: lroStreamName(op.op_id),
  };
}

const MAX_COURSE_COLLECT_ITEMS = 500;

function normalizeCourseCollectItems(
  items: CourseCollectAssignmentItem[],
): CourseCollectAssignmentItem[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("at least one student is required");
  }
  if (items.length > MAX_COURSE_COLLECT_ITEMS) {
    throw new Error(
      `too many students; maximum is ${MAX_COURSE_COLLECT_ITEMS}`,
    );
  }
  return items.map((item) => {
    const student_id = `${item?.student_id ?? ""}`.trim();
    const student_project_id = `${item?.student_project_id ?? ""}`.trim();
    const src_path = `${item?.src_path ?? ""}`.trim();
    const dest_path = `${item?.dest_path ?? ""}`.trim();
    if (!student_id) throw new Error("student_id is required");
    if (!student_project_id) throw new Error("student_project_id is required");
    if (!src_path) throw new Error("src_path is required");
    if (!dest_path) throw new Error("dest_path is required");
    return {
      student_id,
      student_project_id,
      src_path,
      dest_path,
      ...(item.student_account_id
        ? { student_account_id: `${item.student_account_id}`.trim() }
        : {}),
      ...(item.student_name ? { student_name: `${item.student_name}` } : {}),
      ...(item.assignment_title
        ? { assignment_title: `${item.assignment_title}` }
        : {}),
    };
  });
}

export async function collectAssignment({
  account_id,
  course_project_id,
  assignment_id,
  items,
  options,
  run_at,
}: {
  account_id?: string;
  course_project_id: string;
  assignment_id: string;
  items: CourseCollectAssignmentItem[];
  options?: CopyOptions;
  run_at?: string;
}): Promise<CourseCollectAssignmentResult> {
  if (!account_id) {
    throw new Error("user must be signed in");
  }
  const normalizedItems = normalizeCourseCollectItems(items);
  await assertCollab({ account_id, project_id: course_project_id });
  const studentProjectIds = Array.from(
    new Set(normalizedItems.map((item) => item.student_project_id)),
  );
  await ensureCourseManagerAccess({
    account_id,
    course_project_id,
    project_ids: studentProjectIds,
  });
  for (const project_id of studentProjectIds) {
    await assertCollab({ account_id, project_id });
  }
  let normalizedRunAt: string | undefined;
  if (run_at != null) {
    const date = new Date(run_at);
    if (!Number.isFinite(date.getTime())) {
      throw new Error("run_at must be a valid date");
    }
    normalizedRunAt = date.toISOString();
  }
  const op = await createLro({
    kind: COURSE_COLLECT_ASSIGNMENT_LRO_KIND,
    scope_type: "project",
    scope_id: course_project_id,
    created_by: account_id,
    routing: "hub",
    input: {
      course_project_id,
      assignment_id,
      items: normalizedItems,
      options: options ?? { recursive: true },
      ...(normalizedRunAt ? { run_at: normalizedRunAt } : {}),
    },
    dedupe_key: normalizedRunAt
      ? `course-collect:${course_project_id}:${assignment_id}:${normalizedRunAt}`
      : undefined,
    status: "queued",
  });
  try {
    await publishLroSummary({
      scope_type: op.scope_type,
      scope_id: op.scope_id,
      summary: op,
    });
  } catch (err) {
    log.warn("collectAssignment: unable to publish initial LRO summary", {
      op_id: op.op_id,
      course_project_id,
      err,
    });
  }
  triggerCourseCollectLroWorker();
  return courseCollectLroResponse(op);
}

const MAX_COURSE_ASSIGNMENT_PATCH_PATHS = 500;

function normalizeCourseAssignmentPatchRelativePaths(
  relative_paths: string[],
): string[] {
  if (!Array.isArray(relative_paths) || relative_paths.length === 0) {
    throw new Error("at least one relative path is required");
  }
  if (relative_paths.length > MAX_COURSE_ASSIGNMENT_PATCH_PATHS) {
    throw new Error(
      `too many paths; maximum is ${MAX_COURSE_ASSIGNMENT_PATCH_PATHS}`,
    );
  }
  const deduped = new Set<string>();
  for (const raw of relative_paths) {
    const trimmed = `${raw ?? ""}`.trim().replace(/\\/g, "/");
    if (!trimmed) {
      throw new Error("relative path is required");
    }
    if (posix.isAbsolute(trimmed)) {
      throw new Error("relative paths must not be absolute");
    }
    if (trimmed.split("/").some((part) => part === "..")) {
      throw new Error("relative paths must stay inside the assignment");
    }
    const normalized = posix.normalize(trimmed);
    if (!normalized || normalized === ".") {
      throw new Error("relative path is required");
    }
    deduped.add(normalized);
  }
  return Array.from(deduped);
}

function normalizeCourseAssignmentPatchDests(
  dests: CourseAssignmentPatchDestination[],
): CourseAssignmentPatchDestination[] {
  if (!Array.isArray(dests) || dests.length === 0) {
    throw new Error("at least one student is required");
  }
  if (dests.length > MAX_COURSE_COLLECT_ITEMS) {
    throw new Error(
      `too many students; maximum is ${MAX_COURSE_COLLECT_ITEMS}`,
    );
  }
  const deduped = new Map<string, CourseAssignmentPatchDestination>();
  for (const raw of dests) {
    const student_id = `${raw?.student_id ?? ""}`.trim();
    const student_project_id = `${raw?.student_project_id ?? ""}`.trim();
    if (!student_id) throw new Error("student_id is required");
    if (!student_project_id) throw new Error("student_project_id is required");
    const key = `${student_id}\n${student_project_id}`;
    if (!deduped.has(key)) {
      deduped.set(key, { student_id, student_project_id });
    }
  }
  return Array.from(deduped.values());
}

export async function sendCourseAssignmentPatch({
  account_id,
  course_project_id,
  assignment_id,
  src_base_path,
  dest_base_path,
  relative_paths,
  dests,
  options,
}: {
  account_id?: string;
  course_project_id: string;
  assignment_id: string;
  src_base_path: string;
  dest_base_path: string;
  relative_paths: string[];
  dests: CourseAssignmentPatchDestination[];
  options?: CopyOptions;
}): Promise<CourseAssignmentPatchResult> {
  if (!account_id) {
    throw new Error("user must be signed in");
  }
  const normalizedRelativePaths =
    normalizeCourseAssignmentPatchRelativePaths(relative_paths);
  const normalizedDests = normalizeCourseAssignmentPatchDests(dests);

  await assertCollab({ account_id, project_id: course_project_id });
  const studentProjectIds = Array.from(
    new Set(normalizedDests.map((dest) => dest.student_project_id)),
  );
  await ensureCourseManagerAccess({
    account_id,
    course_project_id,
    project_ids: studentProjectIds,
  });
  for (const project_id of studentProjectIds) {
    await assertCollab({ account_id, project_id });
  }

  return await copyPathBetweenProjects({
    account_id,
    src: {
      project_id: course_project_id,
      base_path: src_base_path,
      path: normalizedRelativePaths.map((relativePath) =>
        posix.join(src_base_path, relativePath),
      ),
    },
    dests: normalizedDests.map((dest) => ({
      project_id: dest.student_project_id,
      path: dest_base_path,
      metadata: { student_id: dest.student_id, course_item_id: assignment_id },
    })),
    options: {
      force: false,
      errorOnExist: false,
      ...options,
      recursive: true,
    },
  });
}

const MAX_COPY_DESTINATIONS = 500;

function normalizeCopyDests({
  dest,
  dests,
}: {
  dest?: ProjectCopyDestination;
  dests?: ProjectCopyDestination[];
}): ProjectCopyDestination[] {
  if (dest != null && dests != null) {
    throw new Error("specify exactly one of dest or dests");
  }
  const rawDests = dest != null ? [dest] : dests;
  if (!Array.isArray(rawDests) || rawDests.length === 0) {
    throw new Error("at least one destination is required");
  }
  if (rawDests.length > MAX_COPY_DESTINATIONS) {
    throw new Error(
      `too many destinations; maximum is ${MAX_COPY_DESTINATIONS}`,
    );
  }
  const deduped = new Map<string, ProjectCopyDestination>();
  for (const raw of rawDests) {
    const project_id = `${raw?.project_id ?? ""}`.trim();
    const path = `${raw?.path ?? ""}`.trim();
    if (!project_id) {
      throw new Error("destination project_id is required");
    }
    const key = `${project_id}\n${path}`;
    if (!deduped.has(key)) {
      deduped.set(key, {
        project_id,
        path,
        ...(raw.metadata != null ? { metadata: raw.metadata } : {}),
      });
    }
  }
  return Array.from(deduped.values());
}

function basename(path: string): string {
  const parts = `${path ?? ""}`.split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

function normalizeImportTargetPath(path?: string): string {
  const trimmed = `${path ?? ""}`.trim().replace(/\\/g, "/");
  if (!trimmed) {
    throw new Error("path is required");
  }
  const normalized = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  if (
    !normalized ||
    normalized === "." ||
    normalized.includes("/../") ||
    normalized.startsWith("../") ||
    normalized.endsWith("/..")
  ) {
    throw new Error("path must stay within the target project");
  }
  return normalized;
}

async function getProjectHostId(project_id: string): Promise<string> {
  return (await getAssignedProjectHostInfo(project_id)).host_id;
}

const PROJECT_RUNTIME_LOG_STATES = new Set([
  "running",
  "starting",
  "restarting",
]);

async function getProjectRuntimeLogInfo(project_id: string): Promise<{
  host_id: string | null;
  state: string;
} | null> {
  const { rows } = await getPool().query<{
    host_id: string | null;
    state: string | null;
  }>(
    "SELECT host_id, COALESCE(state->>'state', '') AS state FROM projects WHERE project_id=$1 LIMIT 1",
    [project_id],
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    host_id: row.host_id ?? null,
    state: row.state ?? "",
  };
}

async function syncProjectSecretsCacheOnAssignedHost({
  project_id,
}: {
  project_id: string;
}): Promise<void> {
  let host_id: string;
  try {
    host_id = await getProjectHostId(project_id);
  } catch (err) {
    log.debug("project secrets cache sync skipped; no assigned host", {
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
    log.warn("project secrets cache sync to host failed", {
      project_id,
      host_id,
      err: `${err}`,
    });
  }
}

async function resolvePublicImportSource({
  public_url,
}: {
  public_url: string;
}): Promise<{
  parsed: ReturnType<typeof parsePublicViewerImportUrl>;
  source_project_id: string;
  host_id: string;
}> {
  const parsed = parsePublicViewerImportUrl(public_url);
  const settings = await getServerSettings();
  const viewerDns = resolvePublicViewerDns({
    publicViewerDns: settings.public_viewer_dns as string | undefined,
    dns: settings.dns as string | undefined,
  });
  const viewerHostname = (() => {
    const raw = `${viewerDns ?? settings.dns ?? ""}`.trim();
    if (!raw) return undefined;
    try {
      return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
        .hostname;
    } catch {
      return undefined;
    }
  })();
  const sourceUrl = new URL(parsed.rawUrl);
  if (
    !viewerHostname ||
    !isAllowedPublicViewerSourceHost({
      sourceHostname: sourceUrl.hostname,
      viewerHostname,
    })
  ) {
    throw new Error("public import source host is not allowed");
  }
  const source_project_id = extractProjectIdFromPublicViewerRawUrl(
    parsed.rawUrl,
  );
  if (!source_project_id) {
    throw new Error("unable to determine source project for public import");
  }
  const host_id = await getProjectHostId(source_project_id);
  return { parsed, source_project_id, host_id };
}

export async function importPublicUrl({
  account_id,
  project_id,
  public_url,
  path,
}: {
  account_id?: string;
  project_id: string;
  public_url: string;
  path?: string;
}): Promise<ImportPublicUrlResult> {
  await assertCollabAllowRemoteProjectAccess({ account_id, project_id });
  const { parsed } = await resolvePublicImportSource({ public_url });

  const response = await fetch(parsed.rawUrl, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `failed to fetch public source (${response.status} ${response.statusText})`,
    );
  }
  const maxBytes = 100 * 1024 * 1024;
  const contentLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("public import source is too large");
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new Error("public import source is too large");
  }
  const destPath = normalizeImportTargetPath(path || basename(parsed.path));
  const fs = await projectFs(project_id);
  const parent = posix.dirname(destPath);
  if (parent && parent !== ".") {
    await fs.mkdir(parent, { recursive: true });
  }
  await fs.writeFile(destPath, buffer);
  return {
    project_id,
    path: destPath,
    bytes: buffer.byteLength,
    source_url: parsed.rawUrl,
  };
}

export async function inspectPublicPath({
  account_id,
  public_url,
}: {
  account_id?: string;
  public_url: string;
}): Promise<PublicPathInspectionResult> {
  const { parsed, source_project_id, host_id } =
    await resolvePublicImportSource({
      public_url,
    });
  const client = await getRoutedHostControlClient({
    host_id,
  });
  const inspection = await client.inspectStaticAppPath({
    project_id: source_project_id,
    url: parsed.rawUrl,
  });
  if (
    !(inspection.exposure_mode === "public" && inspection.public_access_granted)
  ) {
    await assertCollab({ account_id, project_id: source_project_id });
  }
  return {
    source_project_id,
    host_id,
    app_id: inspection.app_id,
    static_root: inspection.static_root,
    exposure_mode: inspection.exposure_mode,
    auth_front: inspection.auth_front,
    public_access_granted: inspection.public_access_granted,
    requested: inspection.requested,
    containing_directory: inspection.containing_directory,
  };
}

export async function importPublicPath({
  account_id,
  project_id,
  public_url,
  mode,
  path,
}: {
  account_id?: string;
  project_id: string;
  public_url: string;
  mode: "file" | "directory";
  path?: string;
}): Promise<ImportPublicPathResult> {
  await assertCollabAllowRemoteProjectAccess({ account_id, project_id });
  const inspection = await inspectPublicPath({ account_id, public_url });
  const source =
    mode === "directory"
      ? inspection.containing_directory
      : inspection.requested;
  const suggestedName =
    basename(source.relative_path) || basename(inspection.static_root);
  const destPath = normalizeImportTargetPath(path || suggestedName);
  const op = await copyPathBetweenProjects({
    account_id,
    src: {
      project_id: inspection.source_project_id,
      path: source.container_path,
    },
    dest: {
      project_id,
      path: destPath,
    },
  });
  return {
    ...op,
    project_id,
    path: destPath,
    source_project_id: inspection.source_project_id,
    source_path: source.container_path,
    mode,
  };
}

export async function listPendingCopies({
  account_id,
  project_id,
  include_completed,
}: {
  account_id?: string;
  project_id: string;
  include_completed?: boolean;
}): Promise<ProjectCopyRow[]> {
  await assertCollab({ account_id, project_id });
  return await listCopiesForProject({ project_id, include_completed });
}

export async function listCopyRowsByOpId({
  account_id,
  op_id,
}: {
  account_id?: string;
  op_id: string;
}): Promise<ProjectCopyRow[]> {
  const op = await getLro(op_id);
  if (!op) {
    return [];
  }
  if (op.kind !== "copy-path-between-projects") {
    throw new Error("operation is not a project copy");
  }
  if (op.scope_type !== "project") {
    throw new Error("copy operation has unsupported scope");
  }
  await assertCollab({ account_id, project_id: op.scope_id });
  return await listCopiesByOpId({ op_id });
}

export async function cancelPendingCopy({
  account_id,
  src_project_id,
  src_path,
  dest_project_id,
  dest_path,
}: {
  account_id?: string;
  src_project_id: string;
  src_path: string;
  dest_project_id: string;
  dest_path: string;
}): Promise<void> {
  await assertCollab({ account_id, project_id: dest_project_id });
  await cancelCopyDb({
    src_project_id,
    src_path,
    dest_project_id,
    dest_path,
  });
}

const log = getLogger("server:conat:api:projects");

const TERMINAL_LRO_STATUSES = new Set([
  "succeeded",
  "failed",
  "canceled",
  "expired",
]);

async function shouldLeaveTerminalLroUntouched(
  op_id: string,
): Promise<boolean> {
  const current = await getLro(op_id).catch(() => undefined);
  return !!current && TERMINAL_LRO_STATUSES.has(current.status);
}

function publishStartLroSummaryBestEffort({
  scope_type,
  scope_id,
  summary,
  context,
}: {
  scope_type: LroSummary["scope_type"];
  scope_id: string;
  summary: LroSummary;
  context: string;
}): void {
  void publishLroSummary({
    scope_type,
    scope_id,
    summary,
  }).catch((err) => {
    log.warn(`${context}: unable to publish LRO summary`, {
      op_id: summary.op_id,
      scope_id,
      err,
    });
  });
}

function normalizeLogTail(lines?: number): number {
  const n = Number(lines ?? 200);
  if (!Number.isFinite(n)) return 200;
  return Math.max(1, Math.min(5000, Math.floor(n)));
}

export async function getProjectReadDetailsAllowRemote({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}) {
  const localAccess = await getLocalProjectCollaboratorAccessStatus({
    account_id,
    project_id,
  });
  if (localAccess === "local-collaborator") {
    const local = await loadProjectReadDetailsDirect(project_id);
    if (local != null) {
      return local;
    }
    throw new Error(`project ${project_id} not found`);
  }

  const admin = await isAdmin(account_id);
  if (admin) {
    const local = await loadProjectReadDetailsDirect(project_id);
    if (local != null) {
      return local;
    }
  }

  if (localAccess === "not-collaborator") {
    throw new Error(PROJECT_COLLABORATOR_REQUIRED_ERROR);
  }
  if (localAccess === "missing-project") {
    const ownership = await resolveProjectBay(project_id);
    if (!ownership) {
      throw new Error(PROJECT_NOT_FOUND_ERROR);
    }
  }

  const ownership = await resolveProjectBay(project_id);
  if (!ownership || ownership.bay_id === getConfiguredBayId()) {
    throw new Error(PROJECT_NOT_FOUND_ERROR);
  }
  return await getInterBayBridge()
    .projectDetails(ownership.bay_id)
    .get({ account_id, project_id });
}

export async function getProjectRegion({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<ProjectRegion> {
  return (await getProjectReadDetailsAllowRemote({ account_id, project_id }))
    .region;
}

export async function getProjectCreated({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<ProjectCreated> {
  return (await getProjectReadDetailsAllowRemote({ account_id, project_id }))
    .created;
}

export async function getProjectEnv({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<ProjectEnv> {
  return (await getProjectReadDetailsAllowRemote({ account_id, project_id }))
    .env;
}

export async function getProjectRootfs({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<ProjectRootfsConfig | null> {
  return (await getProjectReadDetailsAllowRemote({ account_id, project_id }))
    .rootfs;
}

export async function getProjectRootfsPublishConfig({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<ProjectRootfsPublishConfig | null> {
  return (await getProjectReadDetailsAllowRemote({ account_id, project_id }))
    .rootfs_publish_config;
}

function validateProjectRootfsPublishConfig(
  config: ProjectRootfsPublishConfig | null,
): ProjectRootfsPublishConfig | null {
  if (config == null) return null;
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    config.kind !== "cocalc-project-rootfs-publish-config" ||
    config.version !== 1
  ) {
    throw new Error("invalid RootFS publish config envelope");
  }
  parseRootfsConfigExport(config.config);
  return config;
}

export async function setProjectRootfsPublishConfig({
  account_id,
  project_id,
  config,
}: {
  account_id: string;
  project_id: string;
  config: ProjectRootfsPublishConfig | null;
}): Promise<void> {
  const normalized = validateProjectRootfsPublishConfig(config);
  await assertCollab({ account_id, project_id });
  await withProjectRehomeWriteFence({
    project_id,
    action: "set project RootFS publish config",
    fn: async (db) => {
      await db.query(
        "UPDATE projects SET rootfs_publish_config = $2 WHERE project_id = $1",
        [project_id, normalized],
      );
    },
  });
  await publishProjectDetailInvalidationBestEffort({
    project_id,
    fields: ["rootfs_publish_config"],
  });
}

export async function getProjectLabels({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id: string;
}): Promise<ProjectLabels> {
  await assertCollabAllowRemoteProjectAccess({ account_id, project_id });
  return await getProjectLabelsInDb({ project_id });
}

export async function setProjectLabels({
  account_id,
  project_id,
  labels,
}: {
  account_id?: string;
  project_id: string;
  labels: ProjectLabelPatch;
}): Promise<ProjectLabels> {
  const actor = requireAccountId(account_id);
  await assertCollab({ account_id: actor, project_id });
  return await setProjectLabelsInDb({
    account_id: actor,
    project_id,
    labels,
  });
}

async function getProjectRootfsBuildClient({
  account_id,
  project_id,
  timeout,
}: {
  account_id?: string;
  project_id: string;
  timeout?: number;
}) {
  await assertCollabAllowRemoteProjectAccess({ account_id, project_id });
  const host_id = await getProjectHostId(project_id);
  const client = await getRoutedHostControlClient({
    host_id,
    timeout,
  });
  return { host_id, client };
}

function generateProjectRootfsBuildId(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(".", "")
    .replace("Z", "");
  return `rb-${timestamp}-${randomUUID().slice(0, 8)}`;
}

function mergeProjectRootfsBuildRecordFields(
  status: ProjectRootfsBuildStatusResponse,
  record?: ProjectRootfsBuildRecord,
): ProjectRootfsBuildStatusResponse {
  if (!record) return status;
  return {
    ...status,
    op_id: record.op_id,
    publish_op_id: record.publish_op_id,
    publish_status: record.publish_status,
    publish_image_id: record.publish_image_id,
    publish_error: record.publish_error,
    publish_started_at: record.publish_started_at,
    publish_finished_at: record.publish_finished_at,
  };
}

export async function startProjectRootfsBuild({
  account_id,
  project_id,
  ...start
}: ProjectRootfsBuildStartRequest): Promise<ProjectRootfsBuildStatusResponse> {
  const { host_id, client } = await getProjectRootfsBuildClient({
    account_id,
    project_id,
    timeout: 30_000,
  });
  const build_id = start.build_id ?? generateProjectRootfsBuildId();
  const op = await createProjectRootfsBuildLro({
    account_id,
    project_id,
    host_id,
    build_id,
    recipe_ref: start.recipe_ref,
  });
  try {
    const status = await client.startRootfsBuild({
      ...start,
      build_id,
      project_id,
    });
    const record = await upsertProjectRootfsBuildStatus({
      account_id,
      host_id,
      op_id: op.op_id,
      status,
    });
    await syncProjectRootfsBuildLro({
      op_id: record.op_id,
      status,
    });
    return mergeProjectRootfsBuildRecordFields({ ...status, host_id }, record);
  } catch (err) {
    const failed = await markProjectRootfsBuildFailed({
      account_id,
      project_id,
      host_id,
      build_id,
      op_id: op.op_id,
      recipe_ref: start.recipe_ref,
      error: err,
    });
    await syncProjectRootfsBuildLro({
      op_id: failed.op_id,
      status: {
        build_id,
        project_id,
        status: "failed",
        recipe_ref: start.recipe_ref,
        created_at: failed.created_at,
        finished_at: failed.finished_at,
        error: `${err}`,
        paths: failed.paths ?? {
          dir: "",
          script: "",
          log: "",
          status: "",
          events: "",
        },
      },
    }).catch((syncErr) => {
      log.warn("failed to sync rootfs build LRO after start failure", {
        project_id,
        build_id,
        op_id: op.op_id,
        err: syncErr,
      });
    });
    throw err;
  }
}

export async function getProjectRootfsBuildStatus({
  account_id,
  project_id,
  build_id,
}: ProjectRootfsBuildStatusRequest): Promise<ProjectRootfsBuildStatusResponse> {
  const { host_id, client } = await getProjectRootfsBuildClient({
    account_id,
    project_id,
    timeout: 30_000,
  });
  const status = await client.getRootfsBuildStatus({
    project_id,
    build_id,
  });
  const existing = await getProjectRootfsBuildRecord({
    project_id,
    build_id,
  });
  const record = await upsertProjectRootfsBuildStatus({
    account_id: existing?.account_id ?? account_id,
    host_id,
    op_id: existing?.op_id,
    status,
  });
  await syncProjectRootfsBuildLro({
    op_id: record.op_id,
    status,
  });
  return mergeProjectRootfsBuildRecordFields({ ...status, host_id }, record);
}

export async function getProjectRootfsBuildLog({
  account_id,
  project_id,
  build_id,
  lines,
  byte_offset,
  max_bytes,
}: ProjectRootfsBuildLogRequest): Promise<ProjectRootfsBuildLogResponse> {
  const { host_id, client } = await getProjectRootfsBuildClient({
    account_id,
    project_id,
    timeout: 30_000,
  });
  const log = await client.getRootfsBuildLog({
    project_id,
    build_id,
    lines,
    byte_offset,
    max_bytes,
  });
  return { ...log, host_id };
}

export async function listProjectRootfsBuilds({
  account_id,
  project_id,
  limit,
}: ProjectRootfsBuildListRequest): Promise<ProjectRootfsBuildRecord[]> {
  await assertCollabAllowRemoteProjectAccess({ account_id, project_id });
  return await listProjectRootfsBuildRecords({ project_id, limit });
}

export async function recordProjectRootfsBuildPublish({
  account_id,
  project_id,
  build_id,
  publish_op_id,
}: ProjectRootfsBuildPublishRecordRequest): Promise<ProjectRootfsBuildPublishRecordResponse> {
  await assertCollabAllowRemoteProjectAccess({ account_id, project_id });
  const build = await getProjectRootfsBuildRecord({ project_id, build_id });
  if (!build) {
    throw new Error(`RootFS build not found: ${build_id}`);
  }
  if (build.status !== "succeeded") {
    throw new Error(
      `RootFS build ${build_id} is not publishable: status=${build.status}`,
    );
  }
  const lro = await getLro(publish_op_id);
  if (!lro) {
    throw new Error(`RootFS publish LRO not found: ${publish_op_id}`);
  }
  if (
    lro.kind !== "project-rootfs-publish" ||
    lro.scope_type !== "project" ||
    lro.scope_id !== project_id
  ) {
    throw new Error(
      `LRO ${publish_op_id} is not a RootFS publish for project ${project_id}`,
    );
  }
  const updated = await recordProjectRootfsBuildPublishInDb({
    project_id,
    build_id,
    publish_op_id,
    publish_status: lro.status,
    publish_image_id: lro.result?.image_id ?? null,
    publish_error: lro.error ?? null,
    publish_started_at: lro.started_at,
    publish_finished_at: lro.finished_at,
  });
  if (!updated) {
    throw new Error(`RootFS build not found: ${build_id}`);
  }
  return {
    build: updated,
    publish: {
      op_id: lro.op_id,
      scope_type: "project",
      scope_id: project_id,
      service: PERSIST_SERVICE,
      stream_name: lroStreamName(lro.op_id),
    },
  };
}

export async function cancelProjectRootfsBuild({
  account_id,
  project_id,
  build_id,
}: ProjectRootfsBuildCancelRequest): Promise<ProjectRootfsBuildCancelResponse> {
  const { host_id, client } = await getProjectRootfsBuildClient({
    account_id,
    project_id,
    timeout: 30_000,
  });
  const cancel = await client.cancelRootfsBuild({
    project_id,
    build_id,
  });
  let op_id = (
    await getProjectRootfsBuildRecord({
      project_id,
      build_id,
    })
  )?.op_id;
  try {
    const status = await client.getRootfsBuildStatus({
      project_id,
      build_id,
    });
    const record = await upsertProjectRootfsBuildStatus({
      account_id,
      host_id,
      op_id,
      status,
    });
    op_id = record.op_id;
    await syncProjectRootfsBuildLro({
      op_id,
      status,
    });
  } catch (err) {
    log.warn("failed to refresh rootfs build status after cancel", {
      project_id,
      build_id,
      host_id,
      err,
    });
  }
  return { ...cancel, host_id, op_id };
}

export async function setProjectEnv({
  account_id,
  project_id,
  env,
}: {
  account_id: string;
  project_id: string;
  env: ProjectEnv;
}): Promise<void> {
  validateProjectEnv(env);
  await assertCollab({ account_id, project_id });
  await withProjectRehomeWriteFence({
    project_id,
    action: "set project environment",
    fn: async (db) => {
      await db.query("UPDATE projects SET env = $2 WHERE project_id = $1", [
        project_id,
        env,
      ]);
    },
  });
  await publishProjectDetailInvalidationBestEffort({
    project_id,
    fields: ["env"],
  });
}

export async function setProjectManageUsersOwnerOnly({
  account_id,
  project_id,
  manage_users_owner_only,
}: {
  account_id?: string;
  project_id: string;
  manage_users_owner_only: boolean;
}): Promise<void> {
  const actor = requireAccountId(account_id);
  if (!isValidUUID(project_id)) {
    throw new Error("invalid project_id");
  }
  if (typeof manage_users_owner_only !== "boolean") {
    throw new Error("manage_users_owner_only must be a boolean");
  }
  const ownership = await resolveProjectBay(project_id);
  if (ownership != null && ownership.bay_id !== getConfiguredBayId()) {
    await getInterBayBridge()
      .projectCollabInvite(ownership.bay_id)
      .setManageUsersOwnerOnly({
        account_id: actor,
        project_id,
        manage_users_owner_only,
      });
    return;
  }
  await setLocalProjectManageUsersOwnerOnly({
    account_id: actor,
    project_id,
    manage_users_owner_only,
  });
}

export async function setLocalProjectManageUsersOwnerOnly({
  account_id,
  project_id,
  manage_users_owner_only,
}: {
  account_id: string;
  project_id: string;
  manage_users_owner_only: boolean;
}): Promise<void> {
  if (!isValidUUID(account_id) || !isValidUUID(project_id)) {
    throw new Error("invalid account_id or project_id");
  }
  if (typeof manage_users_owner_only !== "boolean") {
    throw new Error("manage_users_owner_only must be a boolean");
  }
  const settings = (await getServerSettings()) as Record<string, any>;
  if (
    settings.strict_collaborator_management &&
    manage_users_owner_only !== true
  ) {
    throw new Error(
      "Collaborator management is enforced by the site administrator and cannot be disabled.",
    );
  }
  const admin = await isAdmin(account_id);
  const default_bay_id = getConfiguredBayId();
  await withProjectRehomeWriteFence({
    project_id,
    action: "change project collaborator management policy",
    fn: async (db) => {
      const { rows } = (await db.query(
        `UPDATE projects
            SET manage_users_owner_only=$3
          WHERE project_id=$1
            AND COALESCE(owning_bay_id, $4) = $4
            AND ($5::boolean OR users -> $2::text ->> 'group' = 'owner')
          RETURNING project_id::text AS project_id`,
        [
          project_id,
          account_id,
          manage_users_owner_only,
          default_bay_id,
          admin,
        ],
      )) as { rows: { project_id: string }[] };
      if (!rows[0]?.project_id) {
        throw new Error(
          "Only project owners and administrators can change collaborator management settings",
        );
      }
      await appendProjectOutboxEventForProject({
        db,
        event_type: "project.membership_changed",
        project_id,
        default_bay_id,
      });
    },
  });
  await publishProjectAccountFeedEventsBestEffort({
    project_id,
    default_bay_id,
  });
  await publishProjectDetailInvalidationBestEffort({
    project_id,
    fields: ["manage_users_owner_only"],
  });
}

function requireAccountId(account_id?: string): string {
  const value = `${account_id ?? ""}`.trim();
  if (!value) {
    throw new Error("must be signed in");
  }
  return value;
}

async function resolveRequiredProjectBay(project_id: string) {
  const ownership = await resolveProjectBay(project_id);
  if (ownership == null) {
    throw new Error(`project ${project_id} not found`);
  }
  return ownership;
}

export async function listProjectSecrets({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id: string;
}): Promise<ProjectSecretMetadata[]> {
  const actor = requireAccountId(account_id);
  const ownership = await resolveRequiredProjectBay(project_id);
  if (ownership.bay_id !== getConfiguredBayId()) {
    return await getInterBayBridge().projectSecrets(ownership.bay_id).list({
      account_id: actor,
      project_id,
      epoch: ownership.epoch,
    });
  }
  await assertCollab({ account_id: actor, project_id });
  return await listProjectSecretsInDb({ project_id });
}

export async function setProjectSecret({
  account_id,
  project_id,
  name,
  value,
}: {
  account_id?: string;
  project_id: string;
  name: string;
  value: string;
}): Promise<ProjectSecretMetadata> {
  const actor = requireAccountId(account_id);
  const ownership = await resolveRequiredProjectBay(project_id);
  if (ownership.bay_id !== getConfiguredBayId()) {
    const result = await getInterBayBridge()
      .projectSecrets(ownership.bay_id)
      .set({
        account_id: actor,
        project_id,
        name,
        value,
        epoch: ownership.epoch,
      });
    return result;
  }
  await assertCollab({ account_id: actor, project_id });
  const result = await setProjectSecretInDb({
    project_id,
    name,
    value,
    account_id: actor,
  });
  await publishProjectDetailInvalidationBestEffort({
    project_id,
    fields: ["secrets"],
  });
  await syncProjectSecretsCacheOnAssignedHost({ project_id });
  return result;
}

export async function deleteProjectSecret({
  account_id,
  project_id,
  name,
}: {
  account_id?: string;
  project_id: string;
  name: string;
}): Promise<{ deleted: boolean }> {
  const actor = requireAccountId(account_id);
  const ownership = await resolveRequiredProjectBay(project_id);
  if (ownership.bay_id !== getConfiguredBayId()) {
    return await getInterBayBridge().projectSecrets(ownership.bay_id).delete({
      account_id: actor,
      project_id,
      name,
      epoch: ownership.epoch,
    });
  }
  await assertCollab({ account_id: actor, project_id });
  const deleted = await deleteProjectSecretInDb({
    project_id,
    name,
    account_id: actor,
  });
  await publishProjectDetailInvalidationBestEffort({
    project_id,
    fields: ["secrets"],
  });
  if (deleted) {
    await syncProjectSecretsCacheOnAssignedHost({ project_id });
  }
  return { deleted };
}

export async function copyProjectSecrets({
  account_id,
  source_project_id,
  target_project_id,
  names,
  overwrite,
}: {
  account_id?: string;
  source_project_id: string;
  target_project_id: string;
  names?: string[];
  overwrite?: boolean;
}): Promise<CopyProjectSecretsResult> {
  const actor = requireAccountId(account_id);
  const sourceOwnership = await resolveRequiredProjectBay(source_project_id);
  const targetOwnership = await resolveRequiredProjectBay(target_project_id);
  let result: CopyProjectSecretsResult;
  if (sourceOwnership.bay_id === targetOwnership.bay_id) {
    if (sourceOwnership.bay_id !== getConfiguredBayId()) {
      result = await getInterBayBridge()
        .projectSecrets(sourceOwnership.bay_id)
        .copy({
          account_id: actor,
          source_project_id,
          target_project_id,
          names,
          overwrite,
          source_epoch: sourceOwnership.epoch,
          target_epoch: targetOwnership.epoch,
        });
    } else {
      await assertCollab({ account_id: actor, project_id: source_project_id });
      await assertCollab({ account_id: actor, project_id: target_project_id });
      result = await copyProjectSecretsInDb({
        source_project_id,
        target_project_id,
        names,
        overwrite,
        account_id: actor,
      });
    }
  } else {
    let exported: Awaited<ReturnType<typeof exportProjectSecretsForCopy>>;
    if (sourceOwnership.bay_id === getConfiguredBayId()) {
      await assertCollab({
        account_id: actor,
        project_id: source_project_id,
      });
      exported = await exportProjectSecretsForCopy({
        project_id: source_project_id,
        names,
      });
    } else {
      exported = await getInterBayBridge()
        .projectSecrets(sourceOwnership.bay_id)
        .exportForCopy({
          account_id: actor,
          project_id: source_project_id,
          names,
          epoch: sourceOwnership.epoch,
        });
    }
    if (exported.missing.length > 0) {
      return { copied: [], conflicts: [], missing: exported.missing };
    }
    if (targetOwnership.bay_id === getConfiguredBayId()) {
      await assertCollab({
        account_id: actor,
        project_id: target_project_id,
      });
      result = await importProjectSecretsForCopy({
        account_id: actor,
        project_id: target_project_id,
        secrets: exported.secrets,
        overwrite,
      });
    } else {
      result = await getInterBayBridge()
        .projectSecrets(targetOwnership.bay_id)
        .importForCopy({
          account_id: actor,
          project_id: target_project_id,
          secrets: exported.secrets,
          overwrite,
          epoch: targetOwnership.epoch,
        });
    }
  }
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

export async function generateProjectSshKeySecret({
  account_id,
  browser_id,
  session_hash,
  project_id,
  secret_name,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  project_id: string;
  secret_name?: string;
}): Promise<GenerateProjectSshKeySecretResult> {
  const actor = requireAccountId(account_id);
  const authSession = await requireDangerousProjectMutationAuth({
    account_id: actor,
    browser_id,
    session_hash,
  });
  const actorSessionHash = authSession?.session_hash ?? session_hash;
  const ownership = await resolveRequiredProjectBay(project_id);
  if (ownership.bay_id !== getConfiguredBayId()) {
    return await getInterBayBridge()
      .projectSecrets(ownership.bay_id)
      .generateSshKeySecret({
        account_id: actor,
        session_hash: actorSessionHash,
        project_id,
        secret_name,
        epoch: ownership.epoch,
      });
  }
  await assertCollab({ account_id: actor, project_id });
  const result = await generateProjectSshKeySecretLocal({
    project_id,
    account_id: actor,
    secret_name,
  });
  await publishProjectDetailInvalidationBestEffort({
    project_id,
    fields: ["secrets"],
  });
  return result;
}

export async function getProjectSnapshotSchedule({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<ProjectSnapshotSchedule> {
  return (await getProjectReadDetailsAllowRemote({ account_id, project_id }))
    .snapshots;
}

export async function getProjectBackupSchedule({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<ProjectBackupSchedule> {
  return (await getProjectReadDetailsAllowRemote({ account_id, project_id }))
    .backups;
}

export async function getProjectRunQuota({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<ProjectRunQuota> {
  return (await getProjectReadDetailsAllowRemote({ account_id, project_id }))
    .run_quota;
}

export async function getProjectCourseInfo({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<ProjectCourseInfo> {
  return (await getProjectReadDetailsAllowRemote({ account_id, project_id }))
    .course;
}

export async function getProjectRuntimeSponsorStatus({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<ProjectRuntimeSponsorStatus> {
  await assertCollabAllowRemoteProjectAccess({ account_id, project_id });
  const sponsor = await loadProjectRuntimeSponsor(project_id);
  const [slots, membership, sponsor_display_name] = await Promise.all([
    listProjectRuntimeSlots({
      sponsor_account_id: sponsor.sponsor_account_id,
      active_only: true,
    }),
    resolveMembershipForAccount(sponsor.sponsor_account_id),
    getName(sponsor.sponsor_account_id).catch(() => undefined),
  ]);
  const active_projects = await runtimeSponsorActiveProjectsForViewer({
    account_id,
    slots,
  });
  const limit =
    getEffectiveMembershipUsageLimits(membership)
      .max_sponsored_running_projects ?? null;
  return {
    sponsor_account_id: sponsor.sponsor_account_id,
    ...(sponsor_display_name ? { sponsor_display_name } : {}),
    limit,
    current: slots.length,
    active_projects,
    allow_collaborator_starts_using_sponsor:
      sponsor.allow_collaborator_starts_using_sponsor !== false,
    autostart_enabled: sponsor.autostart_enabled !== false,
  };
}

export async function getAccountRuntimeSponsorStatus({
  account_id,
}: {
  account_id: string;
}): Promise<AccountRuntimeSponsorStatus> {
  const [slots, membership, sponsor_display_name] = await Promise.all([
    listProjectRuntimeSlots({
      sponsor_account_id: account_id,
      active_only: true,
    }),
    resolveMembershipForAccount(account_id),
    getName(account_id).catch(() => undefined),
  ]);
  const active_projects = await runtimeSponsorActiveProjectsForViewer({
    account_id,
    slots,
  });
  const limit =
    getEffectiveMembershipUsageLimits(membership)
      .max_sponsored_running_projects ?? null;
  return {
    sponsor_account_id: account_id,
    ...(sponsor_display_name ? { sponsor_display_name } : {}),
    limit,
    current: slots.length,
    active_projects,
    can_upgrade: true,
    can_change_sponsor: false,
  };
}

function normalizeProjectListWindowLimit(limit?: number): number {
  if (limit == null) {
    return 50;
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw Error("limit must be a positive integer");
  }
  return Math.min(limit, ACCOUNT_PROJECT_LIST_WINDOW_MAX_LIMIT);
}

function normalizeProjectListWindowOffset(offset?: number): number {
  if (offset == null) {
    return 0;
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw Error("offset must be a nonnegative integer");
  }
  return offset;
}

function normalizeProjectListWindowSort(
  sort?: AccountProjectListWindowSort,
): AccountProjectListWindowSort {
  switch (sort) {
    case undefined:
      return "last_edited";
    case "last_edited":
    case "title":
    case "state":
      return sort;
    default:
      throw Error(`unsupported project list sort '${sort}'`);
  }
}

export async function listAccountProjectWindow({
  account_id,
  limit,
  offset,
  hidden,
  search,
  sort,
}: {
  account_id: string;
  limit?: number;
  offset?: number;
  hidden?: boolean;
  search?: string;
  sort?: AccountProjectListWindowSort;
}): Promise<AccountProjectListWindowRow[]> {
  return await listProjectedProjectsForAccount({
    account_id,
    limit: normalizeProjectListWindowLimit(limit),
    offset: normalizeProjectListWindowOffset(offset),
    include_hidden: !!hidden,
    search,
    sort: normalizeProjectListWindowSort(sort),
  });
}

export async function getCourseStudentAccess({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<CourseStudentAccessStatus> {
  const details = await getProjectReadDetailsAllowRemote({
    account_id,
    project_id,
  });
  const course = details.course;
  const requiredMembershipClass = `${course?.required_membership_class ?? ""}`
    .trim()
    .toLowerCase();
  if (
    course?.type !== "student" ||
    !requiredMembershipClass ||
    course.account_id !== account_id
  ) {
    return { status: "not-required", course };
  }

  const requiredTier = await getSeedMembershipTierById({
    id: requiredMembershipClass,
  });
  if (requiredTier == null) {
    return {
      status: "blocked",
      required_membership_class: requiredMembershipClass,
      course,
    };
  }
  const requiredPriority = requiredTier.priority ?? 0;
  const membership = await resolveMembershipForAccount(account_id);
  const currentTier = await getSeedMembershipTierById({ id: membership.class });
  if ((currentTier?.priority ?? 0) >= requiredPriority) {
    return {
      status: "active",
      source:
        membership.grant_source === "course-seat"
          ? "course-seat"
          : membership.grant_source === "student-course-purchase"
            ? "student-course-purchase"
            : membership.grant_source === "site-license"
              ? "site-license"
              : "membership",
      required_membership_class: requiredMembershipClass,
      required_label: requiredTier?.label,
      current_membership_class: membership.class,
      current_expires: membership.expires ?? null,
      course,
    };
  }

  const assignedCourseMembership =
    await getAssignedDirectCoursePackageMembership({
      account_id,
      project_id,
      course_project_id: `${course.project_id ?? ""}`.trim(),
      requiredMembershipClass,
      requiredPriority,
    });
  if (assignedCourseMembership) {
    return {
      status: "active",
      source: "student-course-purchase",
      required_membership_class: requiredMembershipClass,
      required_label: requiredTier?.label,
      current_membership_class: assignedCourseMembership.membership_class,
      current_expires: assignedCourseMembership.expires_at ?? null,
      course,
    };
  }

  if (course.site_license_pay) {
    const claimables = await listClaimableMembershipPackagesForAccount({
      account_id,
    });
    let matchingSiteLicense: (typeof claimables)[number] | undefined;
    for (const pkg of claimables) {
      if (pkg.kind !== "site") {
        continue;
      }
      const pkgTier = await getSeedMembershipTierById({
        id: pkg.membership_class,
      });
      if (
        pkg.membership_class === requiredMembershipClass ||
        (pkgTier?.priority ?? 0) >= requiredPriority
      ) {
        matchingSiteLicense = pkg;
        break;
      }
    }
    if (matchingSiteLicense) {
      return {
        status: "site-license-claimable",
        required_membership_class: requiredMembershipClass,
        required_label: requiredTier?.label,
        package_id: matchingSiteLicense.package_id,
        membership_class: matchingSiteLicense.membership_class,
        matched_email_address: matchingSiteLicense.matched_email_address,
        expires_at: matchingSiteLicense.expires_at ?? null,
        course,
      };
    }
  }

  const requiredAt = dayjs(
    course.student_membership_required_at ?? details.created ?? undefined,
  );
  const graceDays =
    typeof course.student_membership_grace_days === "number" &&
    Number.isFinite(course.student_membership_grace_days)
      ? course.student_membership_grace_days
      : 14;
  const deadline = requiredAt.isValid()
    ? requiredAt.add(graceDays, "day")
    : undefined;
  if (deadline?.isValid() && deadline.isAfter(dayjs())) {
    return {
      status: "grace",
      required_membership_class: requiredMembershipClass,
      required_label: requiredTier?.label,
      deadline: deadline.toDate(),
      course,
    };
  }
  return {
    status: "blocked",
    required_membership_class: requiredMembershipClass,
    required_label: requiredTier?.label,
    deadline: deadline?.isValid() ? deadline.toDate() : null,
    course,
  };
}

async function getAssignedDirectCoursePackageMembership({
  account_id,
  project_id,
  course_project_id,
  requiredMembershipClass,
  requiredPriority,
}: {
  account_id: string;
  project_id: string;
  course_project_id: string;
  requiredMembershipClass: string;
  requiredPriority: number;
}): Promise<
  | {
      membership_class: string;
      expires_at?: Date | string | null;
    }
  | undefined
> {
  const packages = await listMembershipPackageDetailsForOwner({
    owner_account_id: account_id,
  });
  for (const membershipPackage of packages) {
    if (membershipPackage.kind !== "course") {
      continue;
    }
    const startsAt =
      membershipPackage.starts_at == null
        ? undefined
        : new Date(membershipPackage.starts_at);
    if (startsAt && startsAt > new Date()) {
      continue;
    }
    const expiresAt =
      membershipPackage.expires_at == null
        ? undefined
        : new Date(membershipPackage.expires_at);
    if (expiresAt && expiresAt <= new Date()) {
      continue;
    }
    const metadata = membershipPackage.metadata ?? {};
    if (
      metadata.direct_student_purchase !== true ||
      `${metadata.project_id ?? ""}`.trim() !== project_id ||
      `${metadata.course_project_id ?? ""}`.trim() !== course_project_id
    ) {
      continue;
    }
    const assignment = membershipPackage.assignments.find(
      (assignment) =>
        assignment.account_id === account_id && assignment.revoked_at == null,
    );
    const tier = await getSeedMembershipTierById({
      id: membershipPackage.membership_class,
    });
    if (
      membershipPackage.membership_class === requiredMembershipClass ||
      (tier?.priority ?? 0) >= requiredPriority
    ) {
      if (!assignment?.grant_id) {
        try {
          await assignMembershipPackageSeat({
            package_id: membershipPackage.id,
            account_id,
            assigned_by_account_id: account_id,
            metadata,
          });
        } catch (err) {
          log.warn(
            "getCourseStudentAccess: unable to repair direct student course membership assignment",
            {
              account_id,
              project_id,
              package_id: membershipPackage.id,
              err,
            },
          );
          continue;
        }
      }
      return {
        membership_class: membershipPackage.membership_class,
        expires_at: membershipPackage.expires_at ?? null,
      };
    }
  }
}

export async function createCollabInvite({
  account_id,
  project_id,
  invitee_account_id,
  message,
  direct,
  invite_role,
  read_policy,
}: {
  account_id?: string;
  project_id: string;
  invitee_account_id: string;
  message?: string;
  direct?: boolean;
  invite_role?: "collaborator" | "viewer";
  read_policy?: ProjectViewerReadPolicy | null;
}) {
  await assertCollabAllowRemoteProjectAccess({ account_id, project_id });
  const ownership = await resolveProjectBay(project_id);
  if (ownership == null) {
    throw new Error(`project ${project_id} not found`);
  }
  if (ownership.bay_id === getConfiguredBayId()) {
    return await createCollabInviteLocal({
      account_id,
      project_id,
      invitee_account_id,
      message,
      direct,
      invite_role,
      read_policy,
    });
  }
  const result = await getInterBayBridge()
    .projectCollabInvite(ownership.bay_id)
    .create({
      account_id: account_id!,
      project_id,
      invitee_account_id,
      message,
      direct,
      invite_role,
      read_policy,
    });
  return {
    created: result.created,
    invite: collabInviteFromWire(result.invite),
  };
}

export async function inviteCollaboratorWithoutAccount({
  account_id,
  opts,
}: {
  account_id?: string;
  opts: {
    project_id: string;
    title: string;
    link2proj: string;
    replyto?: string;
    replyto_name?: string;
    to: string;
    email: string;
    subject?: string;
    message?: string;
    send_email?: boolean;
    invite_context?: Record<string, unknown>;
    invite_scope?: string;
    invite_role?: "collaborator" | "viewer";
    invite_base_url?: string;
    read_policy?: ProjectViewerReadPolicy | null;
  };
}) {
  if (!account_id) {
    throw new Error("user must be signed in");
  }
  await assertCollabAllowRemoteProjectAccess({
    account_id,
    project_id: opts.project_id,
  });
  const ownership = await resolveProjectBay(opts.project_id);
  if (ownership == null) {
    throw new Error(`project ${opts.project_id} not found`);
  }
  if (ownership.bay_id === getConfiguredBayId()) {
    return await inviteCollaboratorWithoutAccountLocal({ account_id, opts });
  }
  const result = await getInterBayBridge()
    .projectCollabInvite(ownership.bay_id)
    .inviteWithoutAccount({
      account_id,
      opts,
    });
  return {
    email_sent: result.email_sent,
    email_available: result.email_available,
    manual_delivery_required: result.manual_delivery_required,
    email_blocked_reason:
      result.email_blocked_reason as ProjectInviteEmailBlockedReason | null,
    invites: result.invites.map((invite) => collabInviteFromWire(invite)),
  };
}

export async function listCollabInvites({
  account_id,
  project_id,
  direction,
  status,
  limit,
  projectWide,
}: {
  account_id?: string;
  project_id?: string;
  direction?: ProjectCollabInviteDirection;
  status?: ProjectCollabInviteStatus;
  limit?: number;
  projectWide?: boolean;
}) {
  if (!project_id) {
    return await listCollabInvitesLocal({
      account_id,
      direction,
      status,
      limit,
      projectWide,
    });
  }
  const ownership = await resolveProjectBay(project_id);
  if (ownership == null || ownership.bay_id === getConfiguredBayId()) {
    return await listCollabInvitesLocal({
      account_id,
      project_id,
      direction,
      status,
      limit,
      projectWide,
    });
  }
  const result = await getInterBayBridge()
    .projectCollabInvite(ownership.bay_id)
    .list({
      account_id: account_id!,
      project_id,
      direction,
      status,
      limit,
      projectWide,
    });
  return result.map((invite) => collabInviteFromWire(invite));
}

export async function repairAcceptedCourseStudentInviteAccounts({
  account_id,
  course_project_id,
  students,
}: {
  account_id?: string;
  course_project_id: string;
  students: CourseStudentInviteAccountRepairInput[];
}): Promise<CourseStudentInviteAccountRepairRow[]> {
  if (!account_id) {
    throw new Error("user must be signed in");
  }
  if (!isValidUUID(course_project_id)) {
    throw new Error("invalid course_project_id");
  }
  if (!Array.isArray(students)) {
    throw new Error("students must be an array");
  }
  await assertCollabAllowRemoteProjectAccess({
    account_id,
    project_id: course_project_id,
  });

  const localStudents: CourseStudentInviteAccountRepairInput[] = [];
  const remoteStudentsByBay = new Map<
    string,
    CourseStudentInviteAccountRepairInput[]
  >();
  const seen = new Set<string>();
  const normalizedStudents: CourseStudentInviteAccountRepairInput[] = [];
  for (const student of students) {
    if (
      !isValidUUID(student?.student_id) ||
      !isValidUUID(student?.student_project_id)
    ) {
      throw new Error("invalid student repair input");
    }
    const key = `${student.student_id}:${student.student_project_id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalizedStudents.push(student);
  }

  const localOwnershipByProject = new Map<string, string>();
  const studentProjectIds = [
    ...new Set(normalizedStudents.map((student) => student.student_project_id)),
  ];
  if (studentProjectIds.length > 0) {
    const { rows } = await getPool().query<{
      project_id: string;
      bay_id: string;
    }>(
      `SELECT project_id::text, COALESCE(owning_bay_id, $2)::text AS bay_id
         FROM projects
        WHERE project_id = ANY($1::uuid[])`,
      [studentProjectIds, getConfiguredBayId()],
    );
    for (const row of rows) {
      localOwnershipByProject.set(row.project_id, row.bay_id);
    }
  }

  for (const student of normalizedStudents) {
    const bay_id =
      localOwnershipByProject.get(student.student_project_id) ??
      (await resolveProjectBay(student.student_project_id))?.bay_id;
    if (bay_id == null || bay_id === getConfiguredBayId()) {
      localStudents.push(student);
      continue;
    }
    remoteStudentsByBay.set(bay_id, [
      ...(remoteStudentsByBay.get(bay_id) ?? []),
      student,
    ]);
  }

  const results: CourseStudentInviteAccountRepairRow[] = [];
  if (localStudents.length > 0) {
    results.push(
      ...(await repairAcceptedCourseStudentInviteAccountsLocal({
        account_id,
        course_project_id,
        students: localStudents,
        trustedCourseAccess: true,
      })),
    );
  }
  for (const [bay_id, remoteStudents] of remoteStudentsByBay.entries()) {
    results.push(
      ...(await getInterBayBridge()
        .projectCollabInvite(bay_id)
        .repairAcceptedCourseStudentInviteAccounts({
          account_id,
          course_project_id,
          students: remoteStudents,
        })),
    );
  }
  return results;
}

function uniqueValidProjectIds(project_ids: string[]): string[] {
  if (!Array.isArray(project_ids)) {
    throw new Error("project_ids must be an array");
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const project_id of project_ids) {
    const value = `${project_id ?? ""}`.trim();
    if (!value) {
      continue;
    }
    if (!isValidUUID(value)) {
      throw new Error(`invalid project_id: ${value}`);
    }
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

export async function ensureCourseManagerAccess({
  account_id,
  course_project_id,
  course_path,
  project_ids,
}: {
  account_id?: string;
  course_project_id: string;
  course_path?: string;
  project_ids: string[];
}): Promise<CourseManagerAccessResult[]> {
  if (!account_id) {
    throw new Error("user must be signed in");
  }
  if (!isValidUUID(course_project_id)) {
    throw new Error("invalid course_project_id");
  }
  await assertCollabAllowRemoteProjectAccess({
    account_id,
    project_id: course_project_id,
  });
  const manager_account_ids = (
    await listCollaboratorsLocal({ account_id, project_id: course_project_id })
  )
    .filter(
      (collaborator) =>
        collaborator.group === "owner" || collaborator.group === "collaborator",
    )
    .map((collaborator) => collaborator.account_id);
  const projectIds = uniqueValidProjectIds(project_ids);
  if (projectIds.length === 0) {
    return [];
  }

  const localProjectIds: string[] = [];
  const remoteProjectIdsByBay = new Map<string, string[]>();
  const resultsByProjectId = new Map<string, CourseManagerAccessResult>();
  for (const project_id of projectIds) {
    const ownership = await resolveProjectBay(project_id);
    if (ownership == null) {
      resultsByProjectId.set(project_id, {
        project_id,
        added_account_ids: [],
        error: "project not found",
      });
      continue;
    }
    if (ownership.bay_id === getConfiguredBayId()) {
      localProjectIds.push(project_id);
      continue;
    }
    remoteProjectIdsByBay.set(ownership.bay_id, [
      ...(remoteProjectIdsByBay.get(ownership.bay_id) ?? []),
      project_id,
    ]);
  }

  const common = {
    account_id,
    course_project_id,
    course_path,
    manager_account_ids,
  };
  if (localProjectIds.length > 0) {
    for (const result of await ensureCourseManagerAccessLocal({
      ...common,
      project_ids: localProjectIds,
      trustedCourseAccess: true,
    })) {
      resultsByProjectId.set(result.project_id, result);
    }
  }
  for (const [bay_id, remoteProjectIds] of remoteProjectIdsByBay.entries()) {
    for (const result of await getInterBayBridge()
      .projectCollabInvite(bay_id)
      .ensureCourseManagerAccess({
        ...common,
        project_ids: remoteProjectIds,
      })) {
      resultsByProjectId.set(result.project_id, result);
    }
  }

  return projectIds.map(
    (project_id) =>
      resultsByProjectId.get(project_id) ?? {
        project_id,
        added_account_ids: [],
        error: "project was not checked",
      },
  );
}

export async function removeCollaborator({
  account_id,
  opts,
}: {
  account_id?: string;
  opts: {
    account_id;
    project_id;
  };
}) {
  const ownership = await resolveProjectBay(opts.project_id);
  if (ownership == null || ownership.bay_id === getConfiguredBayId()) {
    return await removeCollaboratorLocal({ account_id: account_id!, opts });
  }
  await getInterBayBridge()
    .projectCollabInvite(ownership.bay_id)
    .removeCollaborator({ account_id: account_id!, opts });
}

export async function setProjectUserRole({
  account_id,
  opts,
}: {
  account_id?: string;
  opts: Parameters<typeof setProjectUserRoleLocal>[0]["opts"];
}) {
  const ownership = await resolveProjectBay(opts.project_id);
  if (ownership == null || ownership.bay_id === getConfiguredBayId()) {
    return await setProjectUserRoleLocal({ account_id: account_id!, opts });
  }
  await getInterBayBridge()
    .projectCollabInvite(ownership.bay_id)
    .setProjectUserRole({ account_id: account_id!, opts });
}

function isCollabInviteNotFound(err: unknown, invite_id: string): boolean {
  const message = err instanceof Error ? err.message : `${err}`;
  return message.includes(`invite '${invite_id}' not found`);
}

async function resolveProjectBayForEmailInvite({
  invite_id,
  token,
}: {
  invite_id?: string;
  token?: string;
}) {
  const token_hash = token
    ? await hashProjectCollabInviteToken(token)
    : undefined;
  const entry = await resolveProjectCollabInviteDirectory({
    ...(invite_id ? { invite_id } : {}),
    ...(token_hash ? { token_hash } : {}),
  });
  if (!entry) {
    return null;
  }
  return {
    bay_id: entry.owning_bay_id,
    invite_id: entry.invite_id,
    project_id: entry.project_id,
  };
}

function requireResolvedEmailInvite(
  ownership: Awaited<ReturnType<typeof resolveProjectBayForEmailInvite>>,
) {
  if (!ownership) {
    throw new Error("This project invite link was not found.");
  }
  return ownership;
}

export async function getProjectCollaboratorInviteUsage({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id: string;
}) {
  if (!account_id) {
    throw new Error("user must be signed in");
  }
  await assertCollabAllowRemoteProjectAccess({ account_id, project_id });
  const ownership = await resolveProjectBay(project_id);
  if (ownership == null) {
    throw new Error(`project ${project_id} not found`);
  }
  if (ownership.bay_id === getConfiguredBayId()) {
    return await getProjectCollaboratorInviteUsageLocal(project_id);
  }
  return await getInterBayBridge()
    .projectCollabInvite(ownership.bay_id)
    .getUsage({ account_id, project_id });
}

export async function respondCollabInvite({
  account_id,
  invite_id,
  project_id,
  action,
}: {
  account_id?: string;
  invite_id: string;
  project_id?: string;
  action: ProjectCollabInviteAction;
}) {
  try {
    return await respondCollabInviteLocal({ account_id, invite_id, action });
  } catch (err) {
    if (!isCollabInviteNotFound(err, invite_id)) {
      throw err;
    }
    if (!account_id) {
      throw err;
    }
    if (!project_id) {
      throw err;
    }
    const ownership = await resolveProjectBay(project_id);
    if (ownership == null || ownership.bay_id === getConfiguredBayId()) {
      throw err;
    }
    const include_email = await isAdmin(account_id);
    const result = await getInterBayBridge()
      .projectCollabInvite(ownership.bay_id)
      .respond({
        account_id,
        invite_id,
        action,
        include_email,
        trusted_product_access_checked: action === "accept",
      });
    return collabInviteFromWire(result);
  }
}

export async function getProjectAccessLandingInfo({
  account_id,
  project_id,
}: Parameters<typeof getProjectAccessLandingInfoLocal>[0]) {
  const ownership = await resolveProjectBay(project_id);
  if (ownership == null || ownership.bay_id === getConfiguredBayId()) {
    return await getProjectAccessLandingInfoLocal({ account_id, project_id });
  }
  return await getInterBayBridge()
    .projectCollabInvite(ownership.bay_id)
    .getProjectAccessLandingInfo({
      account_id: account_id!,
      project_id,
    });
}

export async function requestProjectAccess({
  account_id,
  project_id,
  requested_role,
  read_policy,
  message,
  source,
}: Parameters<typeof requestProjectAccessLocal>[0]) {
  const ownership = await resolveProjectBay(project_id);
  if (ownership == null || ownership.bay_id === getConfiguredBayId()) {
    return await requestProjectAccessLocal({
      account_id,
      project_id,
      requested_role,
      read_policy,
      message,
      source,
    });
  }
  return await getInterBayBridge()
    .projectCollabInvite(ownership.bay_id)
    .requestProjectAccess({
      account_id: account_id!,
      project_id,
      requested_role,
      read_policy,
      message,
      source,
    });
}

export async function listProjectAccessRequests({
  account_id,
  project_id,
  status,
  limit,
}: Parameters<typeof listProjectAccessRequestsLocal>[0]) {
  const ownership = await resolveProjectBay(project_id);
  if (ownership == null || ownership.bay_id === getConfiguredBayId()) {
    return await listProjectAccessRequestsLocal({
      account_id,
      project_id,
      status,
      limit,
    });
  }
  return await getInterBayBridge()
    .projectCollabInvite(ownership.bay_id)
    .listProjectAccessRequests({
      account_id: account_id!,
      project_id,
      status,
      limit,
    });
}

export async function respondProjectAccessRequest({
  account_id,
  project_id,
  request_id,
  action,
  role,
  read_policy,
  message,
}: Parameters<typeof respondProjectAccessRequestLocal>[0]) {
  const ownership = await resolveProjectBay(project_id);
  if (ownership == null || ownership.bay_id === getConfiguredBayId()) {
    return await respondProjectAccessRequestLocal({
      account_id,
      project_id,
      request_id,
      action,
      role,
      read_policy,
      message,
    });
  }
  return await getInterBayBridge()
    .projectCollabInvite(ownership.bay_id)
    .respondProjectAccessRequest({
      account_id: account_id!,
      project_id,
      request_id,
      action,
      role,
      read_policy,
      message,
    });
}

export async function listProjectAccessRequestBlocks({
  account_id,
  project_id,
  limit,
}: Parameters<typeof listProjectAccessRequestBlocksLocal>[0]) {
  const ownership = await resolveProjectBay(project_id);
  if (ownership == null || ownership.bay_id === getConfiguredBayId()) {
    return await listProjectAccessRequestBlocksLocal({
      account_id,
      project_id,
      limit,
    });
  }
  return await getInterBayBridge()
    .projectCollabInvite(ownership.bay_id)
    .listProjectAccessRequestBlocks({
      account_id: account_id!,
      project_id,
      limit,
    });
}

export async function unblockProjectAccessRequester({
  account_id,
  project_id,
  blocked_account_id,
}: Parameters<typeof unblockProjectAccessRequesterLocal>[0]) {
  const ownership = await resolveProjectBay(project_id);
  if (ownership == null || ownership.bay_id === getConfiguredBayId()) {
    return await unblockProjectAccessRequesterLocal({
      account_id,
      project_id,
      blocked_account_id,
    });
  }
  return await getInterBayBridge()
    .projectCollabInvite(ownership.bay_id)
    .unblockProjectAccessRequester({
      account_id: account_id!,
      project_id,
      blocked_account_id,
    });
}

export async function copyEmailProjectInviteLink({
  account_id,
  invite_id,
  project_id,
  invite_base_url,
}: {
  account_id?: string;
  invite_id: string;
  project_id?: string;
  invite_base_url?: string;
}) {
  const ownership = await resolveProjectBayForEmailInvite({ invite_id });
  if (ownership == null || ownership.bay_id === getConfiguredBayId()) {
    return await copyEmailProjectInviteLinkLocal({
      account_id,
      invite_id: ownership?.invite_id ?? invite_id,
      project_id: project_id ?? ownership?.project_id,
      invite_base_url,
    });
  }
  if (!account_id) {
    throw new Error("user must be signed in");
  }
  const result = await getInterBayBridge()
    .projectCollabInvite(ownership.bay_id)
    .copyEmailLink({
      account_id,
      invite_id: ownership.invite_id,
      project_id: project_id ?? ownership.project_id,
      invite_base_url,
    });
  return {
    invite_id: result.invite_id,
    invite_url: result.invite_url,
    expires: result.expires ? new Date(result.expires) : null,
  };
}

function assertEmailInviteAcceptSignedIn(
  account_id: string | undefined,
): asserts account_id is string {
  if (!account_id) {
    throw new Error("user must be signed in");
  }
}

export async function redeemEmailProjectInvite({
  account_id,
  invite_id,
  token,
  project_id,
}: {
  account_id?: string;
  invite_id?: string;
  token: string;
  project_id?: string;
}) {
  assertEmailInviteAcceptSignedIn(account_id);
  const ownership = await resolveProjectBayForEmailInvite({
    invite_id,
    token,
  });
  if (!invite_id) {
    requireResolvedEmailInvite(ownership);
  }
  if (ownership == null || ownership.bay_id === getConfiguredBayId()) {
    return await redeemEmailProjectInviteLocal({
      account_id,
      invite_id: ownership?.invite_id ?? invite_id!,
      token,
      project_id: project_id ?? ownership?.project_id,
    });
  }
  const result = await getInterBayBridge()
    .projectCollabInvite(ownership.bay_id)
    .redeemEmail({
      account_id,
      invite_id: ownership.invite_id,
      token,
      project_id: project_id ?? ownership.project_id,
    });
  return collabInviteFromWire(result);
}

export async function previewEmailProjectInvite({
  account_id,
  invite_id,
  token,
  project_id,
}: {
  account_id?: string;
  invite_id?: string;
  token: string;
  project_id?: string;
}) {
  const ownership = await resolveProjectBayForEmailInvite({
    invite_id,
    token,
  });
  if (!invite_id) {
    requireResolvedEmailInvite(ownership);
  }
  if (ownership == null || ownership.bay_id === getConfiguredBayId()) {
    return await previewEmailProjectInviteLocal({
      account_id,
      invite_id: ownership?.invite_id ?? invite_id!,
      token,
      project_id: project_id ?? ownership?.project_id,
    });
  }
  const result = await getInterBayBridge()
    .projectCollabInvite(ownership.bay_id)
    .previewEmail({
      account_id,
      invite_id: ownership.invite_id,
      token,
      project_id: project_id ?? ownership.project_id,
    });
  return collabInviteFromWire(result);
}

export async function respondEmailProjectInvite({
  account_id,
  action,
  invite_id,
  token,
  project_id,
}: {
  account_id?: string;
  action: ProjectCollabInviteAction;
  invite_id?: string;
  token: string;
  project_id?: string;
}) {
  if (action === "accept") {
    assertEmailInviteAcceptSignedIn(account_id);
  }
  const ownership = await resolveProjectBayForEmailInvite({
    invite_id,
    token,
  });
  if (!invite_id) {
    requireResolvedEmailInvite(ownership);
  }
  if (ownership == null || ownership.bay_id === getConfiguredBayId()) {
    return await respondEmailProjectInviteLocal({
      account_id,
      action,
      invite_id: ownership?.invite_id ?? invite_id!,
      token,
      project_id: project_id ?? ownership?.project_id,
    });
  }
  if (!account_id) {
    throw new Error("user must be signed in");
  }
  const result = await getInterBayBridge()
    .projectCollabInvite(ownership.bay_id)
    .respondEmail({
      account_id,
      action,
      invite_id: ownership.invite_id,
      token,
      project_id: project_id ?? ownership.project_id,
    });
  return collabInviteFromWire(result);
}

export async function exec({
  account_id,
  project_id,
  execOpts,
}: {
  account_id: string;
  project_id: string;
  execOpts: ExecuteCodeOptions;
}): Promise<ExecuteCodeOutput> {
  return await execProject({ account_id, project_id, execOpts });
}

export async function getRuntimeLog({
  account_id,
  project_id,
  lines,
}: {
  account_id: string;
  project_id: string;
  lines?: number;
}): Promise<ProjectRuntimeLog> {
  await assertCollab({ account_id, project_id });
  const tail = normalizeLogTail(lines);
  const info = await getProjectRuntimeLogInfo(project_id);
  if (info != null && !PROJECT_RUNTIME_LOG_STATES.has(info.state)) {
    return {
      project_id,
      host_id: info.host_id,
      container: `project-${project_id}`,
      lines: tail,
      text: "",
      found: false,
      running: false,
      available: false,
      reason: "workspace is not running",
    };
  }
  let host_id: string;
  try {
    host_id = (await getAssignedProjectHostInfo(project_id)).host_id;
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : PROJECT_HAS_NO_ASSIGNED_HOST_ERROR;
    if (reason === PROJECT_HAS_NO_ASSIGNED_HOST_ERROR) {
      return {
        project_id,
        host_id: null,
        container: `project-${project_id}`,
        lines: tail,
        text: "",
        found: false,
        running: false,
        available: false,
        reason,
      };
    }
    throw err;
  }
  if (!host_id) {
    return {
      project_id,
      host_id: null,
      container: `project-${project_id}`,
      lines: tail,
      text: "",
      found: false,
      running: false,
      available: false,
      reason: PROJECT_HAS_NO_ASSIGNED_HOST_ERROR,
    };
  }
  const client = await getRoutedHostControlClient({
    host_id,
  });
  const response = await client.getProjectRuntimeLog({
    project_id,
    lines: tail,
  });
  return {
    project_id,
    host_id,
    container: response.container,
    lines: response.lines,
    text: response.text,
    found: response.found,
    running: response.running,
    available: response.found && response.running,
    reason:
      response.reason ??
      (response.found
        ? response.running
          ? undefined
          : "workspace is not running"
        : "workspace container not found"),
  };
}

export async function resolveWorkspaceSshConnection({
  account_id,
  project_id,
  direct,
}: {
  account_id?: string;
  project_id: string;
  direct?: boolean;
}): Promise<WorkspaceSshConnectionInfo> {
  await assertCollab({ account_id, project_id });
  const row = await getAssignedProjectHostInfo(project_id);
  const metadata = row.metadata ?? {};
  const machine = metadata?.machine ?? {};
  const rawSelfHostMode = machine?.metadata?.self_host_mode;
  const effectiveSelfHostMode =
    machine?.cloud === "self-host" && !rawSelfHostMode
      ? "local"
      : rawSelfHostMode;
  const isLocalSelfHost =
    machine?.cloud === "self-host" && effectiveSelfHostMode === "local";
  const cloudflareHostname =
    `${metadata?.cloudflare_tunnel?.ssh_hostname ?? ""}`.trim() || null;
  let sshServer = row.ssh_server ?? null;
  if (isLocalSelfHost) {
    const sshPort = Number(metadata?.self_host?.ssh_tunnel_port);
    if (Number.isInteger(sshPort) && sshPort > 0 && sshPort <= 65535) {
      const sshHost = resolveOnPremHost();
      sshServer = `${sshHost}:${sshPort}`;
    }
  }
  if (!direct && cloudflareHostname) {
    return {
      workspace_id: project_id,
      host_id: row.host_id,
      transport: "cloudflare-tcp",
      ssh_username: project_id,
      ssh_server: null,
      cloudflare_hostname: cloudflareHostname,
    };
  }
  if (!sshServer) {
    throw new Error("host has no ssh server endpoint");
  }
  return {
    workspace_id: project_id,
    host_id: row.host_id,
    transport: "direct",
    ssh_username: project_id,
    ssh_server: sshServer,
    cloudflare_hostname: cloudflareHostname,
  };
}

export async function resolveProjectSshConnection({
  account_id,
  project_id,
  direct,
}: {
  account_id?: string;
  project_id: string;
  direct?: boolean;
}): Promise<WorkspaceSshConnectionInfo> {
  return await resolveWorkspaceSshConnection({
    account_id,
    project_id,
    direct,
  });
}

export async function start({
  account_id,
  project_id,
  restore: _restore,
  restore_backup_id,
  autostart,
  managed_egress_override,
  managed_egress_override_auth,
  wait = true,
}: {
  account_id: string;
  project_id: string;
  // not used; passed through for typing compatibility with project-host
  run_quota?: any;
  // not used; passed through for typing compatibility with project-host
  restore?: "none" | "auto" | "required";
  restore_backup_id?: string;
  autostart?: boolean;
  managed_egress_override?: ManagedProjectEgressOverride;
  managed_egress_override_auth?: typeof PROJECT_DANGEROUS_INTERNAL_AUTH;
  wait?: boolean;
}): Promise<{
  op_id: string;
  scope_type: "project";
  scope_id: string;
  service: string;
  stream_name: string;
}> {
  return await runProjectStartLikeAction({
    kind: "start",
    account_id,
    project_id,
    restore_backup_id,
    autostart,
    managed_egress_override,
    managed_egress_override_auth,
    wait,
  });
}

export async function startFromHost({
  host_id,
  account_id,
  project_id,
  autostart,
  wait = true,
}: {
  host_id?: string;
  account_id: string;
  project_id: string;
  autostart?: boolean;
  wait?: boolean;
}): Promise<{
  op_id: string;
  scope_type: "project";
  scope_id: string;
  service: string;
  stream_name: string;
}> {
  await assertProjectAssignedToHostForStart({ host_id, project_id });
  return await runProjectStartLikeAction({
    kind: "start",
    account_id,
    project_id,
    autostart,
    wait,
  });
}

export async function restart({
  account_id,
  project_id,
  wait = true,
}: {
  account_id: string;
  project_id: string;
  wait?: boolean;
}): Promise<{
  op_id: string;
  scope_type: "project";
  scope_id: string;
  service: string;
  stream_name: string;
}> {
  return await runProjectStartLikeAction({
    kind: "restart",
    account_id,
    project_id,
    wait,
  });
}

async function assertProjectAssignedToHostForStart({
  host_id,
  project_id,
}: {
  host_id?: string;
  project_id: string;
}): Promise<void> {
  if (!host_id) {
    throw new Error("host_id is required");
  }
  const { rows } = await getPool().query(
    `
      SELECT 1
      FROM projects
      JOIN project_hosts
        ON project_hosts.id = projects.host_id
       AND project_hosts.deleted IS NULL
      WHERE projects.project_id=$1
        AND projects.host_id=$2
        AND projects.deleted IS NOT true
        AND COALESCE(projects.owning_bay_id, $3) = COALESCE(project_hosts.bay_id, $3)
      LIMIT 1
    `,
    [project_id, host_id, getConfiguredBayId()],
  );
  if (rows.length === 0) {
    throw new Error(`project ${project_id} is not assigned to host ${host_id}`);
  }
}

async function runProjectStartLikeAction({
  kind,
  account_id,
  project_id,
  restore_backup_id,
  autostart,
  managed_egress_override,
  managed_egress_override_auth,
  wait = true,
}: {
  kind: "start" | "restart";
  account_id: string;
  project_id: string;
  restore_backup_id?: string;
  autostart?: boolean;
  managed_egress_override?: ManagedProjectEgressOverride;
  managed_egress_override_auth?: typeof PROJECT_DANGEROUS_INTERNAL_AUTH;
  wait?: boolean;
}): Promise<{
  op_id: string;
  scope_type: "project";
  scope_id: string;
  service: string;
  stream_name: string;
}> {
  await assertCollabAllowRemoteProjectAccess({ account_id, project_id });
  await assertProjectNotHardDeleting({ project_id });
  if (
    managed_egress_override != null &&
    managed_egress_override_auth !== PROJECT_DANGEROUS_INTERNAL_AUTH &&
    !(await isAdmin(account_id))
  ) {
    throw new Error("managed egress override requires admin authorization");
  }
  try {
    const ownership = await resolveProjectBay(project_id);
    if (ownership == null) {
      throw new Error(`project ${project_id} not found`);
    }
    await getInterBayBridge()
      .projectControl(ownership.bay_id, {
        timeout_ms: projectStartControlTimeoutMs({ restore_backup_id }),
      })
      .checkStartAdmission({
        project_id,
        account_id,
        ...(restore_backup_id ? { restore_backup_id } : {}),
        ...(autostart ? { autostart } : {}),
        source_bay_id: getConfiguredBayId(),
        ...(managed_egress_override ? { managed_egress_override } : {}),
        epoch: ownership.epoch,
      });
  } catch (err) {
    const runtimeSponsorDenial = extractRuntimeSponsorDenial(err);
    if (runtimeSponsorDenial) {
      const enrichedRuntimeSponsorDenial = await enrichRuntimeSponsorDenial({
        denial: runtimeSponsorDenial,
        account_id,
      });
      throw new Error(encodeRuntimeSponsorDenial(enrichedRuntimeSponsorDenial));
    }
    throw err;
  }
  const op = await createLro({
    kind: "project-start",
    scope_type: "project",
    scope_id: project_id,
    created_by: account_id,
    routing: "hub",
    input: {
      project_id,
      action: kind,
      ...(restore_backup_id ? { restore_backup_id } : {}),
      ...(autostart ? { autostart } : {}),
    },
    status: "queued",
  });
  publishStartLroSummaryBestEffort({
    scope_type: op.scope_type,
    scope_id: op.scope_id,
    summary: op,
    context: `${kind}: initial`,
  });
  publishLroEvent({
    scope_type: op.scope_type,
    scope_id: op.scope_id,
    op_id: op.op_id,
    event: {
      type: "progress",
      ts: Date.now(),
      phase: "queued",
      message: "queued",
      progress: 0,
    },
  }).catch((err) => {
    log.warn("start: unable to publish queued progress event", {
      op_id: op.op_id,
      project_id,
      err,
    });
  });

  log.debug(kind, { project_id, op_id: op.op_id });
  const response = {
    op_id: op.op_id,
    scope_type: "project" as const,
    scope_id: project_id,
    service: PERSIST_SERVICE,
    stream_name: lroStreamName(op.op_id),
  };
  const runStart = async () => {
    const running = await updateLro({
      op_id: op.op_id,
      status: "running",
      progress_summary: {
        phase: "queued",
        message: "queued",
        progress: 0,
      },
      error: null,
    });
    if (running) {
      publishStartLroSummaryBestEffort({
        scope_type: running.scope_type,
        scope_id: running.scope_id,
        summary: running,
        context: `${kind}: running`,
      });
    }
    // Keep project start independent of ephemeral progress streams. Move/retry
    // correctness depends on the durable LRO row and project-host RPC; live
    // stream mirroring is optional and has caused orphaned queued starts when
    // the stream backend is unavailable.
    try {
      const ownership = await resolveProjectBay(project_id);
      if (ownership == null) {
        throw new Error(`project ${project_id} not found`);
      }
      const projectControl = getInterBayBridge().projectControl(
        ownership.bay_id,
        { timeout_ms: projectStartControlTimeoutMs({ restore_backup_id }) },
      );
      if (kind === "start") {
        await projectControl.start({
          project_id,
          account_id,
          ...(restore_backup_id ? { restore_backup_id } : {}),
          ...(autostart ? { autostart } : {}),
          lro_op_id: op.op_id,
          source_bay_id: getConfiguredBayId(),
          ...(managed_egress_override ? { managed_egress_override } : {}),
          epoch: ownership.epoch,
        });
      } else {
        await projectControl.restart({
          project_id,
          account_id,
          lro_op_id: op.op_id,
          source_bay_id: getConfiguredBayId(),
          epoch: ownership.epoch,
        });
      }
      const phase_timings_ms = takeStartProjectPhaseTimings(op.op_id);
      const progress_summary = {
        done: 1,
        total: 1,
        failed: 0,
        queued: 0,
        expired: 0,
        applying: 0,
        canceled: 0,
        phase_timings_ms,
      };
      if (await shouldLeaveTerminalLroUntouched(op.op_id)) {
        log.info(`${kind}: leaving terminal project-start lro untouched`, {
          project_id,
          op_id: op.op_id,
        });
        return;
      }
      const updated = await updateLro({
        op_id: op.op_id,
        status: "succeeded",
        progress_summary,
        result: progress_summary,
        error: null,
      });
      if (updated) {
        publishStartLroSummaryBestEffort({
          scope_type: updated.scope_type,
          scope_id: updated.scope_id,
          summary: updated,
          context: `${kind}: succeeded`,
        });
      }
      await supersedeOlderProjectStartLros({
        project_id,
        keep_op_id: op.op_id,
      });
    } catch (err) {
      const runtimeSponsorDenial = extractRuntimeSponsorDenial(err);
      const enrichedRuntimeSponsorDenial = runtimeSponsorDenial
        ? await enrichRuntimeSponsorDenial({
            denial: runtimeSponsorDenial,
            account_id,
          })
        : undefined;
      if (await shouldLeaveTerminalLroUntouched(op.op_id)) {
        log.info(`${kind}: leaving terminal project-start lro untouched`, {
          project_id,
          op_id: op.op_id,
          err: `${err}`,
        });
        return;
      }
      const updated = await updateLro({
        op_id: op.op_id,
        status: "failed",
        error: enrichedRuntimeSponsorDenial
          ? formatRuntimeSponsorDenial(enrichedRuntimeSponsorDenial)
          : `${err}`,
        ...(enrichedRuntimeSponsorDenial
          ? { result: { runtime_sponsor_denial: enrichedRuntimeSponsorDenial } }
          : {}),
      });
      if (updated) {
        publishStartLroSummaryBestEffort({
          scope_type: updated.scope_type,
          scope_id: updated.scope_id,
          summary: updated,
          context: `${kind}: failed`,
        });
      }
      throw err;
    }
  };

  if (wait) {
    await runStart();
  } else {
    runStart().catch((err) =>
      log.warn("async start failed", { project_id, err: `${err}` }),
    );
  }
  return response;
}

export async function stop({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<void> {
  await assertCollabAllowRemoteProjectAccess({ account_id, project_id });
  log.debug("stop", { project_id });
  const ownership = await resolveProjectBay(project_id);
  if (ownership == null) {
    throw new Error(`project ${project_id} not found`);
  }
  await getInterBayBridge().projectControl(ownership.bay_id).stop({
    project_id,
    epoch: ownership.epoch,
  });
}

export async function archiveProject({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id: string;
}): Promise<void> {
  await assertCanPerformDestructiveStorageAction({
    account_id,
    project_id,
    action: "archive this project",
  });

  const { rows } = await getPool().query<{
    host_id: string | null;
    host_status: string | null;
    backup_repo_id: string | null;
    provisioned: boolean | null;
    state: { state?: string } | null;
    last_backup: Date | string | null;
  }>(
    `
      SELECT projects.host_id,
             project_hosts.status AS host_status,
             projects.backup_repo_id,
             projects.provisioned,
             projects.state,
             projects.last_backup
      FROM projects
      LEFT JOIN project_hosts
        ON project_hosts.id = projects.host_id
      WHERE projects.project_id = $1
        AND projects.deleted IS NULL
      LIMIT 1
    `,
    [project_id],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("project not found");
  }

  const currentState = `${row.state?.state ?? ""}`.trim();
  if (currentState === "archived" && row.provisioned === false) {
    return;
  }
  if (!row.backup_repo_id) {
    throw new Error(
      "project must have a configured backup repository before it can be archived",
    );
  }
  const hostStatus = `${row.host_status ?? ""}`.trim().toLowerCase();
  const hostDeprovisioned = hostStatus === "deprovisioned";
  const hostCanRunMutations =
    !hostStatus || hostStatus === "active" || hostStatus === "running";

  if (!hostDeprovisioned) {
    const routedClient = await getExplicitProjectRoutedClient({
      project_id,
      fresh: true,
      account_id: account_id!,
    });
    try {
      try {
        const backups = await getBackups({
          client: routedClient,
          project_id,
          indexed_only: true,
        });
        if (!backups.length) {
          throw new Error(
            "project must have at least one backup before it can be archived",
          );
        }
      } catch (err) {
        if (
          !isArchiveInfoUnavailableError(err) ||
          !(
            (await hasIndexedProjectBackup(project_id)) ||
            row.last_backup != null
          )
        ) {
          throw err;
        }
        log.warn("archiveProject: verified backup via database metadata", {
          project_id,
          last_backup: row.last_backup,
          error: `${err}`,
        });
      }
    } finally {
      try {
        routedClient.close();
      } catch {
        // ignore close errors
      }
    }
  } else {
    log.info(
      "archiveProject: skipping backup verification for deprovisioned host",
      {
        project_id,
        host_id: row.host_id,
      },
    );
  }

  const ownership = await resolveProjectBay(project_id);
  if (ownership == null) {
    throw new Error(`project ${project_id} not found`);
  }

  if (
    hostCanRunMutations &&
    ["running", "starting", "pending", "stopping"].includes(currentState)
  ) {
    await getInterBayBridge().projectControl(ownership.bay_id).stop({
      project_id,
      epoch: ownership.epoch,
    });
  }

  if (row.provisioned !== false && hostCanRunMutations) {
    const host_id = `${row.host_id ?? ""}`.trim();
    if (!host_id) {
      throw new Error("project has no assigned host to archive from");
    }
    await deleteProjectDataOnHost({
      project_id,
      host_id,
    });
  } else if (row.provisioned !== false) {
    log.info("archiveProject: marking project archived without host mutation", {
      project_id,
      host_id: row.host_id,
      host_status: hostStatus || undefined,
    });
  }

  const checkedAt = new Date();
  const nextState = {
    state: "archived",
    time: checkedAt.toISOString(),
  };
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await assertProjectNotRehoming({
      db: client,
      project_id,
      action: "archive project",
    });
    const result = await client.query(
      `
        UPDATE projects
        SET state = $2::jsonb,
            provisioned = FALSE,
            provisioned_checked_at = $3
        WHERE project_id = $1
          AND deleted IS NULL
      `,
      [project_id, nextState, checkedAt],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new Error("project not found");
    }
    await appendProjectOutboxEventForProject({
      db: client,
      event_type: "project.state_changed",
      project_id,
      default_bay_id: getConfiguredBayId(),
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  await publishProjectAccountFeedEventsBestEffort({
    project_id,
    default_bay_id: getConfiguredBayId(),
  });
}

function isArchiveInfoUnavailableError(err: unknown): boolean {
  const message = `${err}`;
  return (
    message.includes("no subscribers matching") &&
    message.includes(".archive-info.")
  );
}

async function hasIndexedProjectBackup(project_id: string): Promise<boolean> {
  try {
    const { rows } = await getPool().query(
      `
        SELECT 1
        FROM project_backup_indexes
        WHERE project_id = $1
          AND status = 'complete'
        LIMIT 1
      `,
      [project_id],
    );
    return rows.length > 0;
  } catch (err) {
    if (`${err}`.includes("project_backup_indexes")) {
      return false;
    }
    throw err;
  }
}

export async function getProjectState({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}) {
  await assertCollabAllowRemoteProjectAccess({ account_id, project_id });
  const ownership = await resolveProjectBay(project_id);
  if (ownership == null) {
    throw new Error(`project ${project_id} not found`);
  }
  return await getInterBayBridge().projectControl(ownership.bay_id).state({
    project_id,
    epoch: ownership.epoch,
  });
}

export async function getProjectAddress({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<ProjectAddress> {
  await assertCollabAllowRemoteProjectAccess({ account_id, project_id });
  const ownership = await resolveProjectBay(project_id);
  if (ownership == null) {
    throw new Error(`project ${project_id} not found`);
  }
  return await getInterBayBridge().projectControl(ownership.bay_id).address({
    project_id,
    account_id,
    epoch: ownership.epoch,
  });
}

export async function ensureProjectScratchVolume({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<void> {
  await assertCollab({ account_id, project_id });
  const fileServer = await getProjectFileServerClient({
    project_id,
    account_id,
  });
  await fileServer.ensureVolume({ project_id, scratch: true });
}

export async function getProjectActiveOperation({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<ProjectActiveOperationSummary | null> {
  await assertCollabAllowRemoteProjectAccess({ account_id, project_id });
  const ownership = await resolveProjectBay(project_id);
  if (ownership == null) {
    throw new Error(`project ${project_id} not found`);
  }
  return await getInterBayBridge().projectControl(ownership.bay_id).activeOp({
    project_id,
    epoch: ownership.epoch,
  });
}

export async function hardDeleteProject({
  account_id,
  browser_id,
  session_hash,
  project_id,
  backup_retention_days,
  purge_backups_now,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  project_id: string;
  backup_retention_days?: number;
  purge_backups_now?: boolean;
}): Promise<{
  op_id: string;
  scope_type: "account";
  scope_id: string;
  service: string;
  stream_name: string;
}> {
  if (!account_id) {
    throw new Error("must be signed in");
  }
  await requireDangerousProjectMutationAuth({
    account_id,
    browser_id,
    session_hash,
  });
  await assertHardDeleteProjectPermission({
    project_id,
    account_id,
  });
  await assertProjectDeletionProtectionDisabled({ project_id });
  await assertProjectHardDeleteAdmission({
    project_id,
    account_id,
    is_admin: await isAdmin(account_id),
  });
  const op = await createLro({
    kind: "project-hard-delete",
    scope_type: "account",
    scope_id: account_id,
    created_by: account_id,
    routing: "hub",
    input: {
      project_id,
      backup_retention_days,
      purge_backups_now: !!purge_backups_now,
    },
    status: "queued",
    dedupe_key: `project-hard-delete:${project_id}`,
  });
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const marked = await markProjectHardDeleteAccepted({
      db: client,
      project_id,
      op_id: op.op_id,
    });
    if (!marked) {
      throw new Error("project not found");
    }
    await appendProjectOutboxEventForProject({
      db: client,
      event_type: "project.state_changed",
      project_id,
      default_bay_id: getConfiguredBayId(),
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    await updateLro({
      op_id: op.op_id,
      status: "failed",
      error: `${err}`,
    });
    throw err;
  } finally {
    client.release();
  }
  await publishProjectAccountFeedEventsBestEffort({
    project_id,
    default_bay_id: getConfiguredBayId(),
  }).catch((err) => {
    log.warn("hardDeleteProject: failed to publish deleting project feed", {
      project_id,
      op_id: op.op_id,
      err: `${err}`,
    });
  });
  await publishLroSummary({
    scope_type: op.scope_type,
    scope_id: op.scope_id,
    summary: op,
  });
  publishLroEvent({
    scope_type: op.scope_type,
    scope_id: op.scope_id,
    op_id: op.op_id,
    event: {
      type: "progress",
      ts: Date.now(),
      phase: "queued",
      message: "queued",
      progress: 0,
      detail: {
        project_id,
      },
    },
  }).catch(() => {});
  return {
    op_id: op.op_id,
    scope_type: "account",
    scope_id: account_id,
    service: PERSIST_SERVICE,
    stream_name: lroStreamName(op.op_id),
  };
}

export async function setProjectDeletionProtection({
  account_id,
  browser_id,
  session_hash,
  project_id,
  enabled,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  project_id: string;
  enabled: boolean;
}): Promise<{ project_id: string; deletion_protection: boolean }> {
  const actor = requireAccountId(account_id);
  if (!isValidUUID(project_id)) {
    throw new Error("invalid project_id");
  }
  if (typeof enabled !== "boolean") {
    throw new Error("enabled must be a boolean");
  }
  const ownership = await resolveProjectBay(project_id);
  if (ownership != null && ownership.bay_id !== getConfiguredBayId()) {
    return await getInterBayBridge()
      .projectCollabInvite(ownership.bay_id)
      .setDeletionProtection({
        account_id: actor,
        browser_id,
        session_hash,
        project_id,
        enabled,
      });
  }
  return await setLocalProjectDeletionProtection({
    account_id: actor,
    browser_id,
    session_hash,
    project_id,
    enabled,
  });
}

export async function setLocalProjectDeletionProtection({
  account_id,
  browser_id,
  session_hash,
  project_id,
  enabled,
}: {
  account_id: string;
  browser_id?: string | null;
  session_hash?: string | null;
  project_id: string;
  enabled: boolean;
}): Promise<{ project_id: string; deletion_protection: boolean }> {
  if (!isValidUUID(account_id) || !isValidUUID(project_id)) {
    throw new Error("invalid account_id or project_id");
  }
  if (typeof enabled !== "boolean") {
    throw new Error("enabled must be a boolean");
  }
  await assertHardDeleteProjectPermission({
    project_id,
    account_id,
  });
  if (!enabled) {
    await requireDangerousProjectMutationAuth({
      account_id,
      browser_id,
      session_hash,
    });
  }
  const { rows } = await getPool().query<{
    project_id: string;
    deletion_protection: boolean | null;
  }>(
    `
      UPDATE projects
      SET deletion_protection=$2, last_edited=NOW()
      WHERE project_id=$1
      RETURNING project_id, deletion_protection
    `,
    [project_id, !!enabled],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("workspace not found");
  }
  await appendProjectOutboxEventForProject({
    db: getPool(),
    event_type: "project.summary_changed",
    project_id,
    default_bay_id: getConfiguredBayId(),
  });
  await publishProjectAccountFeedEventsBestEffort({
    project_id,
    default_bay_id: getConfiguredBayId(),
  }).catch((err) => {
    log.warn(
      "setProjectDeletionProtection: failed to publish project feed events",
      {
        project_id,
        err: `${err}`,
      },
    );
  });
  return {
    project_id: row.project_id,
    deletion_protection: row.deletion_protection === true,
  };
}

export async function leaveOrDeleteProjects({
  account_id,
  browser_id,
  session_hash,
  project_ids,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  project_ids: string[];
}): Promise<ProjectLeaveOrDeleteResult[]> {
  if (!account_id) {
    throw new Error("must be signed in");
  }
  await requireDangerousProjectMutationAuth({
    account_id,
    browser_id,
    session_hash,
  });

  const localProjectIds: string[] = [];
  const remoteProjectIdsByBay = new Map<string, string[]>();
  for (const project_id of [...new Set(project_ids)]) {
    const ownership = await resolveProjectBay(project_id);
    if (ownership == null || ownership.bay_id === getConfiguredBayId()) {
      localProjectIds.push(project_id);
      continue;
    }
    remoteProjectIdsByBay.set(ownership.bay_id, [
      ...(remoteProjectIdsByBay.get(ownership.bay_id) ?? []),
      project_id,
    ]);
  }

  const results: ProjectLeaveOrDeleteResult[] = [];
  if (localProjectIds.length > 0) {
    results.push(
      ...(await leaveOrDeleteProjectsForAccount({
        account_id,
        project_ids: localProjectIds,
        hardDeleteOwnedProject: async (project_id) =>
          await hardDeleteProject({
            account_id,
            browser_id,
            session_hash,
            project_id,
          }),
      })),
    );
  }
  for (const [bay_id, remoteProjectIds] of remoteProjectIdsByBay.entries()) {
    const remoteResults = await getInterBayBridge()
      .projectCollabInvite(bay_id)
      .leaveOrDeleteProjects({
        account_id,
        project_ids: remoteProjectIds,
      });
    for (const result of remoteResults) {
      switch (result.action) {
        case "removed_self":
        case "hard_deleted":
          results.push({
            project_id: result.project_id,
            action: result.action,
          });
          break;
        case "hard_delete_queued":
          results.push({
            project_id: result.project_id,
            action: result.action,
            op_id: result.op_id,
          });
          break;
        case "transferred":
          if (result.new_owner_account_id) {
            results.push({
              project_id: result.project_id,
              action: result.action,
              new_owner_account_id: result.new_owner_account_id,
            });
          } else {
            results.push({
              project_id: result.project_id,
              action: "error",
              error: "remote transfer result missing new owner account id",
            });
          }
          break;
        case "error":
          results.push({
            project_id: result.project_id,
            action: "error",
            error: result.error ?? "unknown remote project leave/delete error",
          });
          break;
      }
    }
  }
  return results;
}

export async function updateAuthorizedKeysOnHost({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<void> {
  await assertCollab({ account_id, project_id });
  await updateAuthorizedKeysOnHostControl(project_id);
}

export async function setProjectHidden({
  account_id,
  project_id,
  hide,
}: {
  account_id?: string;
  project_id: string;
  hide: boolean;
}): Promise<void> {
  const [result] = await setProjectsHidden({
    account_id,
    project_ids: [project_id],
    hide,
  });
  if (!result?.success) {
    throw new Error(result?.error ?? "unable to set project hidden state");
  }
}

function dedupeProjectIds(project_ids: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const project_id of project_ids) {
    const normalized = `${project_id ?? ""}`.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped;
}

export async function setLocalProjectsHidden({
  account_id,
  project_ids,
  hide,
}: {
  account_id: string;
  project_ids: string[];
  hide: boolean;
}): Promise<ProjectHiddenResult[]> {
  const results = new Map<string, ProjectHiddenResult>();
  const validProjectIds: string[] = [];
  for (const project_id of dedupeProjectIds(project_ids)) {
    if (!isValidUUID(project_id)) {
      results.set(project_id, {
        project_id,
        success: false,
        error: "invalid project_id",
      });
      continue;
    }
    validProjectIds.push(project_id);
  }
  if (validProjectIds.length === 0) {
    return dedupeProjectIds(project_ids).map(
      (project_id) =>
        results.get(project_id) ?? {
          project_id,
          success: false,
          error: "invalid project_id",
        },
    );
  }

  const client = await getPool().connect();
  const default_bay_id = getConfiguredBayId();
  try {
    await client.query("BEGIN");
    await client.query(
      `
        SELECT pg_advisory_xact_lock(hashtext('project-rehome'), hashtext(project_id::text))
        FROM unnest($1::uuid[]) AS project_id
      `,
      [validProjectIds],
    );

    const tableExists = await client.query(
      "SELECT to_regclass('public.project_rehome_operations') AS table_name",
    );
    const blocked = new Set<string>();
    if (tableExists.rows[0]?.table_name != null) {
      const activeRehomes = await client.query<{
        project_id: string;
        op_id: string;
        source_bay_id: string;
        dest_bay_id: string;
        stage: string;
      }>(
        `
          SELECT project_id::text AS project_id, op_id, source_bay_id, dest_bay_id, stage
          FROM project_rehome_operations
          WHERE project_id = ANY($1::uuid[])
            AND status = 'running'
          ORDER BY created_at DESC
        `,
        [validProjectIds],
      );
      for (const row of activeRehomes.rows) {
        blocked.add(row.project_id);
        results.set(row.project_id, {
          project_id: row.project_id,
          success: false,
          error: `cannot set project hidden state for project ${row.project_id}; project rehome ${row.op_id} is running from ${row.source_bay_id} to ${row.dest_bay_id} at stage ${row.stage}`,
        });
      }
    }

    const updateIds = validProjectIds.filter(
      (project_id) => !blocked.has(project_id),
    );
    const updatedIds = new Set<string>();
    if (updateIds.length > 0) {
      const updated = await client.query<{ project_id: string }>(
        `
          UPDATE projects
          SET users = jsonb_set(
            COALESCE(users, '{}'::jsonb),
            ARRAY[$2::text, 'hide'],
            to_jsonb($3::boolean),
            true
          )
          WHERE project_id = ANY($1::uuid[])
            AND COALESCE(owning_bay_id, $4) = $4
            AND (users -> $2::text ->> 'group') IN ('owner', 'collaborator')
          RETURNING project_id::text AS project_id
        `,
        [updateIds, account_id, hide, default_bay_id],
      );
      for (const row of updated.rows) {
        updatedIds.add(row.project_id);
        results.set(row.project_id, {
          project_id: row.project_id,
          success: true,
        });
      }
      for (const project_id of updatedIds) {
        await appendProjectOutboxEventForProject({
          db: client,
          event_type: "project.membership_changed",
          project_id,
          default_bay_id,
        });
      }
    }

    for (const project_id of updateIds) {
      if (!updatedIds.has(project_id)) {
        results.set(project_id, {
          project_id,
          success: false,
          error: "user must be a collaborator",
        });
      }
    }
    await client.query("COMMIT");

    await Promise.all(
      [...updatedIds].map(async (project_id) => {
        try {
          await publishProjectAccountFeedEventsBestEffort({
            project_id,
            default_bay_id,
          });
        } catch (err) {
          log.warn("setProjectsHidden: failed to publish project feed", {
            project_id,
            err: `${err}`,
          });
        }
      }),
    );
  } catch (err) {
    await client.query("ROLLBACK");
    for (const project_id of validProjectIds) {
      if (!results.has(project_id)) {
        results.set(project_id, {
          project_id,
          success: false,
          error: `${err}`,
        });
      }
    }
  } finally {
    client.release();
  }

  return dedupeProjectIds(project_ids).map(
    (project_id) =>
      results.get(project_id) ?? {
        project_id,
        success: false,
        error: "unknown project hidden state error",
      },
  );
}

async function groupProjectIdsForHiddenUpdate({
  project_ids,
}: {
  project_ids: string[];
}): Promise<{
  localProjectIds: string[];
  remoteProjectIdsByBay: Map<string, string[]>;
}> {
  const localProjectIds: string[] = [];
  const remoteProjectIdsByBay = new Map<string, string[]>();
  const default_bay_id = getConfiguredBayId();
  const locallyResolved = new Map<string, string>();
  if (project_ids.length > 0) {
    const { rows } = await getPool().query<{
      project_id: string;
      bay_id: string | null;
    }>(
      `
        SELECT project_id::text AS project_id, COALESCE(owning_bay_id, $2) AS bay_id
        FROM projects
        WHERE project_id = ANY($1::uuid[])
      `,
      [project_ids, default_bay_id],
    );
    for (const row of rows) {
      locallyResolved.set(row.project_id, `${row.bay_id ?? ""}`.trim());
    }
  }

  for (const project_id of project_ids) {
    const localBayId = locallyResolved.get(project_id);
    const bay_id =
      localBayId == null
        ? (await resolveProjectBay(project_id))?.bay_id
        : localBayId;
    if (!bay_id || bay_id === default_bay_id) {
      localProjectIds.push(project_id);
      continue;
    }
    remoteProjectIdsByBay.set(bay_id, [
      ...(remoteProjectIdsByBay.get(bay_id) ?? []),
      project_id,
    ]);
  }
  return { localProjectIds, remoteProjectIdsByBay };
}

export async function setProjectsHidden({
  account_id,
  project_ids,
  hide,
}: {
  account_id?: string;
  project_ids: string[];
  hide: boolean;
}): Promise<ProjectHiddenResult[]> {
  if (!account_id) {
    throw Error("user must be signed in");
  }
  if (typeof hide !== "boolean") {
    throw Error("hide must be a boolean");
  }
  if (!Array.isArray(project_ids)) {
    throw Error("project_ids must be an array");
  }

  const dedupedProjectIds = dedupeProjectIds(project_ids);
  const results = new Map<string, ProjectHiddenResult>();
  const validProjectIds: string[] = [];

  for (const project_id of dedupedProjectIds) {
    if (!isValidUUID(project_id)) {
      results.set(project_id, {
        project_id,
        success: false,
        error: "invalid project_id",
      });
      continue;
    }
    validProjectIds.push(project_id);
  }

  const { localProjectIds, remoteProjectIdsByBay } =
    await groupProjectIdsForHiddenUpdate({ project_ids: validProjectIds });

  for (const result of await setLocalProjectsHidden({
    account_id,
    project_ids: localProjectIds,
    hide,
  })) {
    results.set(result.project_id, result);
  }

  for (const [bay_id, remoteProjectIds] of remoteProjectIdsByBay.entries()) {
    try {
      const remoteResults = await getInterBayBridge()
        .projectCollabInvite(bay_id)
        .setProjectsHidden({
          account_id,
          project_ids: remoteProjectIds,
          hide,
        });
      for (const result of remoteResults) {
        results.set(result.project_id, result);
      }
    } catch (err) {
      for (const project_id of remoteProjectIds) {
        results.set(project_id, {
          project_id,
          success: false,
          error: `${err}`,
        });
      }
    }
  }

  return dedupedProjectIds.map(
    (project_id) =>
      results.get(project_id) ?? {
        project_id,
        success: false,
        error: "unknown project hidden state error",
      },
  );
}

export async function setProjectSshKey({
  account_id,
  browser_id,
  session_hash,
  project_id,
  fingerprint,
  title,
  value,
  creation_date,
  last_use_date,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  project_id: string;
  fingerprint: string;
  title: string;
  value: string;
  creation_date?: number;
  last_use_date?: number;
}): Promise<void> {
  await requireDangerousProjectMutationAuth({
    account_id,
    browser_id,
    session_hash,
  });
  await assertCollab({ account_id, project_id });
  const actor = account_id as string;
  const fp = `${fingerprint ?? ""}`.trim();
  if (!fp) {
    throw Error("fingerprint must be non-empty");
  }
  const payload = {
    title,
    value,
    creation_date: creation_date ?? Date.now(),
    ...(last_use_date != null ? { last_use_date } : {}),
  };
  if (
    !(await upsertProjectSshKeyInDb({
      project_id,
      account_id: actor,
      fingerprint: fp,
      payload,
    }))
  ) {
    throw Error("user must be a collaborator");
  }
}

export async function deleteProjectSshKey({
  account_id,
  browser_id,
  session_hash,
  project_id,
  fingerprint,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  project_id: string;
  fingerprint: string;
}): Promise<void> {
  await requireDangerousProjectMutationAuth({
    account_id,
    browser_id,
    session_hash,
  });
  await assertCollab({ account_id, project_id });
  const actor = account_id as string;
  const fp = `${fingerprint ?? ""}`.trim();
  if (!fp) {
    throw Error("fingerprint must be non-empty");
  }
  if (
    !(await deleteProjectSshKeyInDb({
      project_id,
      account_id: actor,
      fingerprint: fp,
    }))
  ) {
    throw Error("user must be a collaborator");
  }
}

export async function moveProject({
  account_id,
  browser_id,
  session_hash,
  internalAuth,
  project_id,
  dest_host_id,
  allow_offline,
  backup_region_cutover,
}: {
  account_id: string;
  browser_id?: string | null;
  session_hash?: string | null;
  internalAuth?: typeof PROJECT_DANGEROUS_INTERNAL_AUTH;
  project_id: string;
  dest_host_id?: string;
  allow_offline?: boolean;
  backup_region_cutover?: boolean;
}): Promise<{
  op_id: string;
  scope_type: "project";
  scope_id: string;
  service: string;
  stream_name: string;
}> {
  const authSession = await requireDangerousProjectMutationAuth({
    account_id,
    browser_id,
    session_hash,
    internalAuth,
  });
  const actorSessionHash = authSession?.session_hash ?? session_hash;
  await assertCollab({ account_id, project_id });
  const ownership = await resolveProjectBay(project_id);
  if (ownership == null) {
    throw new Error(`project ${project_id} not found`);
  }
  if (ownership.bay_id !== getConfiguredBayId()) {
    return await getInterBayBridge().projectControl(ownership.bay_id).move({
      project_id,
      account_id,
      session_hash: actorSessionHash,
      dest_host_id,
      allow_offline,
      backup_region_cutover,
      epoch: ownership.epoch,
    });
  }
  await assertCanPerformDestructiveStorageAction({
    account_id,
    project_id,
    action: "move this project",
  });
  const sponsor = await loadProjectRuntimeSponsor(project_id);
  await assertCanStartUsingRuntimeSponsor({
    sponsor,
    account_id,
  });
  const movePrecheck = await getMoveOfflinePrecheck({ project_id });
  if (!allow_offline) {
    await ensureMoveOfflineAllowed({
      movePrecheck,
    });
  }
  const reservedRuntimeSlot = await reserveProjectRuntimeSlot({
    ...sponsor,
    project_id,
    actor_account_id: account_id,
    reason: "project-move",
    state: "starting",
    ttl_ms: PROJECT_MOVE_RUNTIME_SLOT_TTL_MS,
    metadata: {
      dest_host_id: dest_host_id ?? null,
      backup_region_cutover: !!backup_region_cutover,
    },
  });
  const lroInput = {
    project_id,
    allow_offline,
    backup_region_cutover,
    source_host_id: movePrecheck.source_host_id,
    runtime_slot: {
      sponsor_account_id: sponsor.sponsor_account_id,
      existing: reservedRuntimeSlot.existing,
    },
    ...(dest_host_id ? { dest_host_id } : {}),
  };
  let op: LroSummary;
  try {
    op = await createLro({
      kind: "project-move",
      scope_type: "project",
      scope_id: project_id,
      created_by: account_id,
      routing: "hub",
      input: lroInput,
      status: "queued",
    });
  } catch (err) {
    if (!reservedRuntimeSlot.existing) {
      await releaseProjectRuntimeSlot({
        sponsor_account_id: sponsor.sponsor_account_id,
        project_id,
        state: "failed",
      }).catch((releaseErr) => {
        log.warn("failed to release runtime slot after move LRO create error", {
          project_id,
          sponsor_account_id: sponsor.sponsor_account_id,
          err: `${releaseErr}`,
        });
      });
    }
    throw err;
  }
  await reserveProjectRuntimeSlot({
    ...sponsor,
    project_id,
    actor_account_id: account_id,
    reason: "project-move",
    op_id: op.op_id,
    state: "starting",
    ttl_ms: PROJECT_MOVE_RUNTIME_SLOT_TTL_MS,
    metadata: {
      dest_host_id: dest_host_id ?? null,
      backup_region_cutover: !!backup_region_cutover,
    },
  }).catch((err) => {
    log.warn("failed to attach move op id to reserved runtime slot", {
      project_id,
      sponsor_account_id: sponsor.sponsor_account_id,
      op_id: op.op_id,
      err: `${err}`,
    });
  });
  try {
    await publishLroSummary({
      scope_type: op.scope_type,
      scope_id: op.scope_id,
      summary: op,
    });
  } catch (err) {
    log.warn("moveProject: unable to publish initial LRO summary", {
      op_id: op.op_id,
      project_id,
      err,
    });
  }
  publishLroEvent({
    scope_type: op.scope_type,
    scope_id: op.scope_id,
    op_id: op.op_id,
    event: {
      type: "progress",
      ts: Date.now(),
      phase: "queued",
      message: "queued",
      progress: 0,
    },
  }).catch((err) => {
    log.warn("moveProject: unable to publish queued progress event", {
      op_id: op.op_id,
      project_id,
      err,
    });
  });

  return {
    op_id: op.op_id,
    scope_type: "project",
    scope_id: project_id,
    service: PERSIST_SERVICE,
    stream_name: lroStreamName(op.op_id),
  };
}

export async function assignProjectHost({
  account_id,
  project_id,
  dest_host_id,
  skip_owner_route,
}: {
  account_id: string;
  project_id: string;
  dest_host_id: string;
  skip_owner_route?: boolean;
}): Promise<void> {
  if (!account_id) {
    throw new Error("user must be signed in");
  }
  if (!dest_host_id) {
    throw new Error("destination host id must be specified");
  }
  await assertCollab({ account_id, project_id });
  const ownership = skip_owner_route
    ? null
    : await resolveProjectBay(project_id);
  if (ownership != null && ownership.bay_id !== getConfiguredBayId()) {
    return await getInterBayBridge()
      .projectControl(ownership.bay_id)
      .assignHost({
        project_id,
        account_id,
        dest_host_id,
        epoch: ownership.epoch,
      });
  }
  await assertProjectNotHardDeleting({ project_id });
  const { rows } = await getPool().query<{ host_id: string | null }>(
    "SELECT host_id FROM projects WHERE project_id=$1 LIMIT 1",
    [project_id],
  );
  if (!rows[0]) {
    throw new Error(`project ${project_id} not found`);
  }
  if (rows[0].host_id) {
    throw new Error("project is already assigned to a host; use move instead");
  }
  const host = await resolveHostConnection({
    account_id,
    host_id: dest_host_id,
  });
  if (!host) {
    throw new Error(`host ${dest_host_id} not found`);
  }
  if ((host as { can_place?: boolean }).can_place !== true) {
    throw new Error("not allowed to place a project on that host");
  }
  await savePlacement(project_id, { host_id: dest_host_id });
}

export async function rehomeProject({
  account_id,
  session_hash,
  project_id,
  dest_bay_id,
  reason,
  campaign_id,
}: {
  account_id: string;
  session_hash?: string | null;
  project_id: string;
  dest_bay_id: string;
  reason?: string | null;
  campaign_id?: string | null;
}): Promise<ProjectRehomeResponse> {
  if (!account_id) {
    throw new Error("user must be signed in");
  }
  await requireDangerousProjectMutationAuth({
    account_id,
    session_hash,
  });
  return await rehomeProjectControl({
    account_id,
    project_id,
    dest_bay_id,
    reason,
    campaign_id,
  });
}

export async function getProjectRehomeOperation({
  account_id,
  op_id,
}: {
  account_id: string;
  op_id: string;
}): Promise<ProjectRehomeOperationSummary | null> {
  if (!account_id) {
    throw new Error("user must be signed in");
  }
  if (!(await isAdmin(account_id))) {
    throw new Error("project rehome status requires admin privileges");
  }
  return (await getProjectRehomeOperationControl(op_id)) ?? null;
}

export async function reconcileProjectRehome({
  account_id,
  session_hash,
  op_id,
}: {
  account_id: string;
  session_hash?: string | null;
  op_id: string;
}): Promise<ProjectRehomeResponse> {
  if (!account_id) {
    throw new Error("user must be signed in");
  }
  await requireDangerousProjectMutationAuth({
    account_id,
    session_hash,
  });
  return await reconcileProjectRehomeControl({
    account_id,
    op_id,
  });
}

export async function drainProjectRehome({
  account_id,
  session_hash,
  source_bay_id,
  dest_bay_id,
  limit,
  dry_run,
  campaign_id,
  reason,
}: {
  account_id: string;
  session_hash?: string | null;
  source_bay_id?: string;
  dest_bay_id: string;
  limit?: number;
  dry_run?: boolean;
  campaign_id?: string | null;
  reason?: string | null;
}) {
  if (!account_id) {
    throw new Error("user must be signed in");
  }
  await requireDangerousProjectMutationAuth({
    account_id,
    session_hash,
  });
  return await drainProjectRehomeControl({
    account_id,
    source_bay_id,
    dest_bay_id,
    limit,
    dry_run,
    campaign_id,
    reason,
  });
}

const HOST_SEEN_TTL_MS = 2 * 60 * 1000;

type MoveOfflinePrecheck = {
  source_host_id?: string;
  last_edited: Date | null;
  last_changed: Date | null;
  last_backup: Date | null;
};

async function getMoveOfflinePrecheck({
  project_id,
}: {
  project_id: string;
}): Promise<MoveOfflinePrecheck> {
  const pool = getPool();
  const { rows } = await pool.query<{
    source_host_id: string | null;
    last_edited: Date | null;
    last_changed: Date | null;
    last_backup: Date | null;
  }>(
    `
      SELECT
        CASE
          WHEN COALESCE(projects.owning_bay_id, $2) = COALESCE(project_hosts.bay_id, $2)
            THEN projects.host_id
          ELSE NULL
        END AS source_host_id,
        projects.last_edited,
        (to_jsonb(projects)->>'last_changed')::TIMESTAMP AS last_changed,
        projects.last_backup
      FROM projects
      LEFT JOIN project_hosts
        ON project_hosts.id = projects.host_id
       AND project_hosts.deleted IS NULL
      WHERE projects.project_id=$1
      LIMIT 1
    `,
    [project_id, getConfiguredBayId()],
  );
  const row = rows[0];
  return {
    source_host_id: row?.source_host_id ?? undefined,
    last_edited: row?.last_edited ?? null,
    last_changed: row?.last_changed ?? null,
    last_backup: row?.last_backup ?? null,
  };
}

async function ensureMoveOfflineAllowed({
  movePrecheck,
}: {
  movePrecheck: MoveOfflinePrecheck;
}): Promise<void> {
  const source_host_id = movePrecheck.source_host_id;
  if (!source_host_id) {
    return;
  }
  const pool = getPool();
  const hostRow = await pool.query<{
    status: string | null;
    deleted: Date | null;
    last_seen: Date | null;
  }>("SELECT status, deleted, last_seen FROM project_hosts WHERE id=$1", [
    source_host_id,
  ]);
  const host = hostRow.rows[0];
  const status = String(host?.status ?? "");
  const lastSeenMs = host?.last_seen
    ? new Date(host.last_seen as any).getTime()
    : 0;
  const seenRecently = lastSeenMs
    ? Date.now() - lastSeenMs <= HOST_SEEN_TTL_MS
    : false;
  const hostAvailable =
    !!host &&
    !host.deleted &&
    ["running", "starting", "restarting", "error"].includes(status) &&
    seenRecently;
  if (hostAvailable) {
    return;
  }
  const lastChanged = movePrecheck.last_changed
    ? new Date(movePrecheck.last_changed).getTime()
    : movePrecheck.last_edited
      ? new Date(movePrecheck.last_edited).getTime()
      : 0;
  const lastBackup = movePrecheck.last_backup
    ? new Date(movePrecheck.last_backup).getTime()
    : 0;
  if (!lastChanged) {
    return;
  }
  if (!lastBackup || lastChanged > lastBackup) {
    throw offlineMoveConfirmationError(
      makeOfflineMoveConfirmationPayload({
        source_status: status || "unknown",
        last_backup: movePrecheck.last_backup,
        last_edited: movePrecheck.last_changed ?? movePrecheck.last_edited,
      }),
    );
  }
}

export async function getSshKeys({
  project_id,
}: {
  project_id?: string;
} = {}): Promise<string[]> {
  if (!project_id) {
    throw Error("project_id must be specified");
  }
  const pool = getPool();
  const keys: string[] = [];
  const f = async (query) => {
    const { rows } = await pool.query(query, [project_id]);
    for (const x of rows) {
      keys.push((x as any).key);
    }
  };

  // The two crazy looking queries below get the ssh public keys
  // for a specific project, both the project-specific keys *AND*
  // the global keys for collabs that happen to apply to the project.
  // We use complicated jsonb so these are weird/complicated queries,
  // which AI wrote (with some uuid casting by me), but they work
  // fine as far as I can tell.
  await Promise.all([
    f(`
SELECT
  ssh_key ->> 'value' AS key
FROM projects
CROSS JOIN LATERAL jsonb_each(users) AS u(user_id, user_data)
CROSS JOIN LATERAL jsonb_each(u.user_data -> 'ssh_keys') AS k(fingerprint, ssh_key)
JOIN accounts a ON a.account_id::TEXT = u.user_id
WHERE project_id = $1
  AND a.banned IS NOT TRUE
  AND COALESCE(u.user_data ->> 'group', '') IN ('owner', 'collaborator');
`),
    f(`
SELECT  kdata ->> 'value' AS key
FROM projects p
CROSS JOIN LATERAL jsonb_object_keys(p.users) AS u(account_id)
JOIN accounts a ON a.account_id::TEXT = u.account_id
CROSS JOIN LATERAL jsonb_each(a.ssh_keys) AS k(fingerprint, kdata)
WHERE p.project_id = $1
  AND a.banned IS NOT TRUE
  AND COALESCE(p.users #>> ARRAY[u.account_id, 'group']::TEXT[], '') IN ('owner', 'collaborator');
`),
  ]);

  return Array.from(new Set<string>(keys));
}

// This is intentionally not implemented in the central hub API yet.
// Device auth must run on a specific project-host, selected by project_id.
export async function codexDeviceAuthStart({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id: string;
}): Promise<never> {
  await assertCollab({ account_id, project_id });
  await assertAccountTrustedForProductAccess(account_id!, "use Codex");
  throw Error(
    "codex device auth is not implemented on central hub; call a project-host endpoint via project routing",
  );
}

export async function codexDeviceAuthStatus({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id: string;
  id: string;
}): Promise<never> {
  await assertCollab({ account_id, project_id });
  throw Error(
    "codex device auth is not implemented on central hub; call a project-host endpoint via project routing",
  );
}

export async function codexDeviceAuthCancel({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id: string;
  id: string;
}): Promise<never> {
  await assertCollab({ account_id, project_id });
  throw Error(
    "codex device auth is not implemented on central hub; call a project-host endpoint via project routing",
  );
}

export async function codexUploadAuthFile({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id: string;
  filename?: string;
  content: string;
}): Promise<never> {
  await assertCollab({ account_id, project_id });
  await assertAccountTrustedForProductAccess(account_id!, "upload Codex auth");
  throw Error(
    "codex auth-file upload is not implemented on central hub; call a project-host endpoint via project routing",
  );
}

export async function getCodexUsageStatus({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id: string;
  timeout?: number;
}): Promise<CodexUsageStatusInfo> {
  await assertCollab({ account_id, project_id });
  return {
    available: false,
    checkedAt: new Date().toISOString(),
    paymentSource: {
      source: "none",
      hasSubscription: false,
      hasProjectApiKey: false,
      hasAccountApiKey: false,
      hasSiteApiKey: false,
      sharedHomeMode: "disabled",
      project_id,
    },
    project_id,
    reason:
      "ChatGPT Codex usage is only available through a running project's project-host. Open the project and retry.",
  };
}

export async function chatStoreStats({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id: string;
  chat_path: string;
  db_path?: string;
}): Promise<never> {
  await assertCollab({ account_id, project_id });
  throw Error(
    "chat store maintenance is not implemented on central hub; call a project-host endpoint via project routing",
  );
}

export async function chatStoreRotate({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id: string;
  chat_path: string;
  db_path?: string;
  keep_recent_messages?: number;
  max_head_bytes?: number;
  max_head_messages?: number;
  require_idle?: boolean;
  force?: boolean;
  dry_run?: boolean;
}): Promise<never> {
  await assertCollab({ account_id, project_id });
  throw Error(
    "chat store maintenance is not implemented on central hub; call a project-host endpoint via project routing",
  );
}

export async function chatStoreListSegments({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id: string;
  chat_path: string;
  db_path?: string;
  limit?: number;
  offset?: number;
}): Promise<never> {
  await assertCollab({ account_id, project_id });
  throw Error(
    "chat store maintenance is not implemented on central hub; call a project-host endpoint via project routing",
  );
}

export async function chatStoreReadArchived({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id: string;
  chat_path: string;
  db_path?: string;
  before_date_ms?: number;
  thread_id?: string;
  limit?: number;
  offset?: number;
}): Promise<never> {
  await assertCollab({ account_id, project_id });
  throw Error(
    "chat store maintenance is not implemented on central hub; call a project-host endpoint via project routing",
  );
}

export async function chatStoreReadArchivedHit({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id: string;
  chat_path: string;
  db_path?: string;
  row_id?: number;
  message_id?: string;
  thread_id?: string;
}): Promise<never> {
  await assertCollab({ account_id, project_id });
  throw Error(
    "chat store maintenance is not implemented on central hub; call a project-host endpoint via project routing",
  );
}

export async function chatStoreSearch({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id: string;
  chat_path: string;
  query: string;
  db_path?: string;
  thread_id?: string;
  exclude_thread_ids?: string[];
  limit?: number;
  offset?: number;
}): Promise<never> {
  await assertCollab({ account_id, project_id });
  throw Error(
    "chat store maintenance is not implemented on central hub; call a project-host endpoint via project routing",
  );
}

export async function chatStoreDelete({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id: string;
  chat_path: string;
  db_path?: string;
  scope: ChatStoreScope;
  before_date_ms?: number;
  thread_id?: string;
  message_ids?: string[];
}): Promise<never> {
  await assertCollab({ account_id, project_id });
  throw Error(
    "chat store maintenance is not implemented on central hub; call a project-host endpoint via project routing",
  );
}

export async function chatStoreVacuum({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id: string;
  chat_path: string;
  db_path?: string;
}): Promise<never> {
  await assertCollab({ account_id, project_id });
  throw Error(
    "chat store maintenance is not implemented on central hub; call a project-host endpoint via project routing",
  );
}
