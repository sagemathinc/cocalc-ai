/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Where a hub API call executes. A routed method runs on the bay that owns
// the data it acts on: the hub that receives the call resolves that bay and,
// if it is another bay, forwards the whole authenticated call there once.
// The method itself is then ordinary single-bay code. Methods without a
// route run where they are received.
//
// Only list methods whose authorization and effects all live on the owning
// bay. Fresh-auth checks are fine: they run on the caller's home bay
// wherever the method runs. Methods that compute other account-home facts at
// the edge (e.g., admin status) are cross-owner workflows; keep them
// explicit.

import { isValidUUID } from "@cocalc/util/misc";

export type HubApiRoute =
  | {
      owner: "project";
      /** Extract the owning project id from the call's arguments. */
      key: (args: any[]) => unknown;
    }
  | {
      // A project host; its owning bay is in the host directory.
      owner: "host";
      /** Extract the host id from the call's arguments. */
      key: (args: any[]) => unknown;
    }
  | {
      // An email collaborator invite, found in the invite directory by id or
      // by its link token. Its owning bay is the project's.
      owner: "collab-invite";
      key: (args: any[]) => unknown;
    }
  | {
      // Several projects, possibly on several bays. The call runs once per
      // owning bay, with the project ids cut down to that bay's projects, and
      // the per-project results are merged in input order. The method takes
      // `project_ids` in its first argument, returns one result per project
      // (with `project_id`), and reports any project its bay does not own as
      // a per-project error.
      owner: "projects";
      key: (args: any[]) => unknown;
      /** The method's result for a project whose bay failed or did not answer. */
      errorResult: (
        project_id: string,
        error: string,
        code?: string | number,
      ) => Record<string, unknown>;
      /**
       * At most this many projects on any one bay per call, for methods that
       * work through them one at a time: more is refused before any part
       * runs, so a part always finishes within the call's time.
       */
      maxPerBay?: number;
    };

export type CollabInviteRouteKey = { invite_id?: string; token?: string };

const projectFromOpts: HubApiRoute = {
  owner: "project",
  key: (args) => args?.[0]?.project_id,
};

const projectFromNestedOpts: HubApiRoute = {
  owner: "project",
  key: (args) => args?.[0]?.opts?.project_id,
};

const courseProjectFromOpts: HubApiRoute = {
  owner: "project",
  key: (args) => args?.[0]?.course_project_id,
};

const hostFromOpts: HubApiRoute = {
  owner: "host",
  key: (args) => args?.[0]?.id,
};

// Global deployment listings ignore the id and read the bay's own rows.
const hostDeploymentScope: HubApiRoute = {
  owner: "host",
  key: (args) => (args?.[0]?.scope_type === "host" ? args?.[0]?.id : undefined),
};

// A host's long-running operations live on the host's bay. Other scopes
// (or none) run where received.
const hostLroScope: HubApiRoute = {
  owner: "host",
  key: (args) =>
    args?.[0]?.scope_type === "host" ? args?.[0]?.scope_id : undefined,
};

const collabInviteFromOpts: HubApiRoute = {
  owner: "collab-invite",
  key: (args) => ({
    invite_id: args?.[0]?.invite_id,
    token: args?.[0]?.token,
  }),
};

const hiddenProjects: HubApiRoute = {
  owner: "projects",
  key: (args) => args?.[0]?.project_ids,
  errorResult: (project_id, error) => ({ project_id, success: false, error }),
};

// Leaving or deleting is destructive and done one project at a time, so a
// call takes at most one project per bay (the UI sends one project per
// call).
export const MAX_LEAVE_OR_DELETE_PER_BAY = 1;

const leftOrDeletedProjects: HubApiRoute = {
  owner: "projects",
  key: (args) => args?.[0]?.project_ids,
  // The code says, e.g., that the outcome is unknown or fresh auth is needed.
  errorResult: (project_id, error, code) => ({
    project_id,
    action: "error",
    error,
    ...(code != null ? { code } : {}),
  }),
  maxPerBay: MAX_LEAVE_OR_DELETE_PER_BAY,
};

const HUB_API_ROUTES: Record<string, HubApiRoute> = {
  "lro.get": hostLroScope,
  "lro.list": hostLroScope,
  "lro.cancel": hostLroScope,
  "lro.dismiss": hostLroScope,
  // Host reads run on the host's owning bay.
  "hosts.getHostLog": hostFromOpts,
  "hosts.getHostAvailability": hostFromOpts,
  "hosts.getHostRuntimeLog": hostFromOpts,
  "hosts.getHostMetricsHistory": hostFromOpts,
  "hosts.listHostRootfsImages": hostFromOpts,
  "hosts.getHostExamState": hostFromOpts,
  "hosts.listHostSshAuthorizedKeys": hostFromOpts,
  "hosts.listHostAccess": hostFromOpts,
  "hosts.listHostRuntimeDeployments": hostDeploymentScope,
  "hosts.getHostManagedComponentStatus": hostFromOpts,
  "hosts.listHostProjects": hostFromOpts,
  // Host changes run on the host's owning bay too.
  "hosts.setHostAccess": hostFromOpts,
  "hosts.removeHostAccess": hostFromOpts,
  "hosts.setHostProjectRamLimit": hostFromOpts,
  "hosts.setHostOwnerSpendLimits": hostFromOpts,
  "hosts.setHostPoolAccess": hostFromOpts,
  "hosts.annotateHostAvailabilityEvent": hostFromOpts,
  "hosts.addHostSshAuthorizedKey": hostFromOpts,
  "hosts.removeHostSshAuthorizedKey": hostFromOpts,
  "hosts.setHostPublicRouteMode": hostFromOpts,
  "hosts.setHostMaintenanceNotice": hostFromOpts,
  "hosts.pullHostRootfsImage": hostFromOpts,
  "hosts.deleteHostRootfsImage": hostFromOpts,
  "hosts.gcDeletedHostRootfsImages": hostFromOpts,
  "hosts.setHostExamConfig": hostFromOpts,
  "hosts.createHostExamRun": hostFromOpts,
  "hosts.rotateHostExamToken": hostFromOpts,
  "hosts.openHostExamRun": hostFromOpts,
  "hosts.updateHostExamDeadline": hostFromOpts,
  "hosts.increaseHostExamCapacity": hostFromOpts,
  "hosts.stopAndEraseHostExamRun": hostFromOpts,
  "hosts.setHostRuntimeDeployments": hostDeploymentScope,
  "hosts.reconcileHostRuntimeDeployments": hostFromOpts,
  "hosts.rollbackHostRuntimeDeployments": hostFromOpts,
  "hosts.reconcileHostSoftware": hostFromOpts,
  // Host lifecycle runs on the host's owning bay.
  "hosts.startHost": hostFromOpts,
  "hosts.stopHost": hostFromOpts,
  "hosts.restartHost": hostFromOpts,
  "hosts.drainHost": hostFromOpts,
  "hosts.backupHostProjects": hostFromOpts,
  "hosts.stopHostProjects": hostFromOpts,
  "hosts.restartHostProjects": hostFromOpts,
  "hosts.deleteHost": hostFromOpts,
  "hosts.forceDeprovisionHost": hostFromOpts,
  "hosts.refreshHostCloudState": hostFromOpts,
  "hosts.removeSelfHostConnector": hostFromOpts,
  "hosts.setHostDeletionProtection": hostFromOpts,
  "hosts.relocateHost": hostFromOpts,
  // Fleet rollout calls these for hosts on any bay (as the rollout's account).
  "hosts.upgradeHostSoftware": hostFromOpts,
  "hosts.rolloutHostManagedComponents": hostFromOpts,
  "hosts.getHostRuntimeDeploymentStatus": hostFromOpts,
  // Project control reads and stop run on the owning bay's handlers.
  "projects.stop": projectFromOpts,
  "projects.getProjectState": projectFromOpts,
  "projects.getProjectAddress": projectFromOpts,
  "projects.getProjectActiveOperation": projectFromOpts,
  // Hiding is per account, but stored in each project's users map.
  "projects.setProjectHidden": projectFromOpts,
  "projects.setProjectsHidden": hiddenProjects,
  // Each bay leaves, transfers or deletes its own projects; fresh auth asks
  // the caller's home bay.
  "projects.leaveOrDeleteProjects": leftOrDeletedProjects,
  // Host placement and moves run where the project, its runtime slot and its
  // operations live; fresh auth for a move asks the caller's home bay.
  "projects.moveProject": projectFromOpts,
  "projects.assignProjectHost": projectFromOpts,
  "projects.setProjectMetadata": projectFromOpts,
  "projects.setProjectDeletionProtection": projectFromOpts,
  "projects.setProjectManageUsersOwnerOnly": projectFromOpts,
  "projects.setProjectUserRole": projectFromNestedOpts,
  "projects.getProjectAccessLandingInfo": projectFromOpts,
  "projects.requestProjectAccess": projectFromOpts,
  "projects.listProjectAccessRequests": projectFromOpts,
  "projects.respondProjectAccessRequest": projectFromOpts,
  "projects.listProjectAccessRequestBlocks": projectFromOpts,
  "projects.unblockProjectAccessRequester": projectFromOpts,
  "projects.getProjectCollaboratorInviteUsage": projectFromOpts,
  "projects.listProjectSecrets": projectFromOpts,
  "projects.refreshProjectSecretsRuntime": projectFromOpts,
  "projects.setProjectSecret": projectFromOpts,
  "projects.deleteProjectSecret": projectFromOpts,
  "projects.generateProjectSshKeySecret": projectFromOpts,
  // Collaborators and invites. Calls without a project id (an invitee's own
  // inbox) run where they are received.
  "projects.createCollabInvite": projectFromOpts,
  "projects.inviteCollaboratorWithoutAccount": projectFromNestedOpts,
  "projects.listCollabInvites": projectFromOpts,
  "projects.respondCollabInvite": projectFromOpts,
  "projects.removeCollaborator": projectFromNestedOpts,
  // Ownership lives with the project; fresh auth and admin status are asked
  // of the caller's home bay.
  "projects.transferProjectOwnership": projectFromOpts,
  "projects.copyEmailProjectInviteLink": collabInviteFromOpts,
  "projects.redeemEmailProjectInvite": collabInviteFromOpts,
  "projects.previewEmailProjectInvite": collabInviteFromOpts,
  "projects.respondEmailProjectInvite": collabInviteFromOpts,
  // Course secrets live on the course project's owning bay.
  // Course reconfigure operations live on the course project's owning bay.
  "projects.reconfigureCourseProjects": courseProjectFromOpts,
  "projects.getCourseReconfigureOperation": courseProjectFromOpts,
  "projects.cancelCourseReconfigureOperation": courseProjectFromOpts,
  // Course collections live on the course project's owning bay (#1001).
  "projects.collectAssignment": courseProjectFromOpts,
  "projects.addScheduledCollectionStudents": courseProjectFromOpts,
  "projects.getCourseCollectionOperation": courseProjectFromOpts,
  "projects.cancelCourseCollectionOperation": courseProjectFromOpts,
  "projects.listCourseShareableSecrets": courseProjectFromOpts,
  "projects.getCourseSecretPolicy": courseProjectFromOpts,
  "projects.previewCourseSecretSync": courseProjectFromOpts,
  "projects.setProjectSecretCourseSharing": projectFromOpts,
  "projects.setCourseSecretPolicy": courseProjectFromOpts,
  "projects.setCourseSecretGrants": courseProjectFromOpts,
  "projects.approveCourseSecretRecipients": courseProjectFromOpts,
  "projects.revokeCourseSecretRecipients": courseProjectFromOpts,
  "projects.startCourseSecretSync": courseProjectFromOpts,
  "projects.startCourseSecretCleanup": courseProjectFromOpts,
  "projects.getCourseSecretSyncStatus": courseProjectFromOpts,
  "projects.revokeCourseSecretPolicy": courseProjectFromOpts,
  // Course managers are the course project's collaborators, known on its
  // bay; that bay grants them access to student projects on other bays.
  "projects.ensureCourseManagerAccess": courseProjectFromOpts,
  "projects.repairAcceptedCourseStudentInviteAccounts": courseProjectFromOpts,
  // Sending an assignment patch grants the course's managers access first.
  "projects.sendCourseAssignmentPatch": courseProjectFromOpts,
  // A document's edit history (TimeTravel) lives with its project.
  "sync.history": projectFromOpts,
  "sync.purgeHistory": projectFromOpts,
  // a project's edit history and logs (conat/project/persist-storage.ts)
  "projects.listProjectPersistStorage": projectFromOpts,
  "projects.applyProjectPersistStorage": projectFromOpts,
  // Admin overrides apply where the project is; isAdmin asks the admin's
  // home bay (#904).
  "projects.getAdminProjectEntitlementOverride": projectFromOpts,
  "projects.setAdminProjectEntitlementOverride": projectFromOpts,
  "projects.clearAdminProjectEntitlementOverride": projectFromOpts,
};

export function getHubApiRoute(name: string): HubApiRoute | undefined {
  return Object.prototype.hasOwnProperty.call(HUB_API_ROUTES, name)
    ? HUB_API_ROUTES[name]
    : undefined;
}

export function getHubApiRoutedMethods(): string[] {
  return Object.keys(HUB_API_ROUTES).sort();
}

// Email invite link tokens are opaque; bound their size before hashing.
const MAX_INVITE_TOKEN_LENGTH = 512;

/** The owning key of a routed call, or undefined if it is not well formed. */
export function hubApiRouteKey(
  route: HubApiRoute,
  args: any[],
): string | CollabInviteRouteKey | undefined {
  // A call on several projects is split by bay instead (splitProjectIds).
  if (route.owner === "projects") return;
  const key = route.key(args);
  if (route.owner === "project" || route.owner === "host") {
    return typeof key === "string" && isValidUUID(key) ? key : undefined;
  }
  const { invite_id, token } = (key ?? {}) as Record<string, unknown>;
  const out: CollabInviteRouteKey = {};
  if (typeof invite_id === "string" && isValidUUID(invite_id)) {
    out.invite_id = invite_id;
  }
  if (
    typeof token === "string" &&
    token.length > 0 &&
    token.length <= MAX_INVITE_TOKEN_LENGTH
  ) {
    out.token = token;
  }
  return out.invite_id || out.token ? out : undefined;
}

// A call on several projects takes at most this many ids.
export const MAX_PROJECTS_PER_CALL = 1000;

/**
 * Project ids as a call on several projects uses them: trimmed, valid UUIDs
 * in lower case (as the database returns them), empty ones dropped,
 * duplicates removed, in order. Throws on more than MAX_PROJECTS_PER_CALL.
 */
export function normalizeProjectIds(project_ids: unknown[]): string[] {
  if (project_ids.length > MAX_PROJECTS_PER_CALL) {
    throw new Error(
      `at most ${MAX_PROJECTS_PER_CALL} projects may be given in one call`,
    );
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const project_id of project_ids) {
    let id = `${project_id ?? ""}`.trim();
    if (!id) continue;
    if (isValidUUID(id)) id = id.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * The project ids of a call on several projects, normalized as the method
 * normalizes them, or undefined if the call has no list.
 */
export function splitProjectIds(
  route: HubApiRoute,
  args: any[],
): string[] | undefined {
  if (route.owner !== "projects") return;
  const ids = route.key(args);
  if (!Array.isArray(ids)) return;
  return normalizeProjectIds(ids);
}
