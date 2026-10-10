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
      // An email collaborator invite, found in the invite directory by id or
      // by its link token. Its owning bay is the project's.
      owner: "collab-invite";
      key: (args: any[]) => unknown;
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

const collabInviteFromOpts: HubApiRoute = {
  owner: "collab-invite",
  key: (args) => ({
    invite_id: args?.[0]?.invite_id,
    token: args?.[0]?.token,
  }),
};

const HUB_API_ROUTES: Record<string, HubApiRoute> = {
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
  "projects.copyEmailProjectInviteLink": collabInviteFromOpts,
  "projects.redeemEmailProjectInvite": collabInviteFromOpts,
  "projects.previewEmailProjectInvite": collabInviteFromOpts,
  "projects.respondEmailProjectInvite": collabInviteFromOpts,
  // Course secrets live on the course project's owning bay.
  // Course reconfigure operations live on the course project's owning bay.
  "projects.reconfigureCourseProjects": courseProjectFromOpts,
  "projects.getCourseReconfigureOperation": courseProjectFromOpts,
  "projects.cancelCourseReconfigureOperation": courseProjectFromOpts,
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
  const key = route.key(args);
  if (route.owner === "project") {
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
