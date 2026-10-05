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

export type HubApiRoute = {
  owner: "project";
  /** Extract the owning key from the call's arguments. */
  key: (args: any[]) => unknown;
};

const projectFromOpts: HubApiRoute = {
  owner: "project",
  key: (args) => args?.[0]?.project_id,
};

const projectFromNestedOpts: HubApiRoute = {
  owner: "project",
  key: (args) => args?.[0]?.opts?.project_id,
};

const HUB_API_ROUTES: Record<string, HubApiRoute> = {
  "projects.setProjectMetadata": projectFromOpts,
  "projects.setProjectDeletionProtection": projectFromOpts,
  "projects.setProjectManageUsersOwnerOnly": projectFromOpts,
  "projects.setProjectUserRole": projectFromNestedOpts,
  "projects.listProjectSecrets": projectFromOpts,
  "projects.refreshProjectSecretsRuntime": projectFromOpts,
  "projects.setProjectSecret": projectFromOpts,
  "projects.deleteProjectSecret": projectFromOpts,
  "projects.generateProjectSshKeySecret": projectFromOpts,
};

export function getHubApiRoute(name: string): HubApiRoute | undefined {
  return Object.prototype.hasOwnProperty.call(HUB_API_ROUTES, name)
    ? HUB_API_ROUTES[name]
    : undefined;
}

export function getHubApiRoutedMethods(): string[] {
  return Object.keys(HUB_API_ROUTES).sort();
}

/** The owning key of a routed call, or undefined if it is not well formed. */
export function hubApiRouteKey(
  route: HubApiRoute,
  args: any[],
): string | undefined {
  const key = route.key(args);
  return typeof key === "string" && isValidUUID(key) ? key : undefined;
}
