/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getHubApiPrincipalPolicy } from "./index";
import {
  getHubApiRoute,
  getHubApiRoutedMethods,
  hubApiRouteKey,
} from "./routes";

const PROJECT = "6b0f0b1e-2a1f-4b7e-8d7c-0c2f8a9b1c3d";

describe("hub API routes", () => {
  it("routes only real methods that accounts can call", () => {
    for (const name of getHubApiRoutedMethods()) {
      expect([name, getHubApiPrincipalPolicy(name)]).toEqual([name, "account"]);
    }
  });

  it("finds each routed method's owning project", () => {
    expect(
      hubApiRouteKey(getHubApiRoute("projects.setProjectMetadata")!, [
        { project_id: PROJECT },
      ]),
    ).toBe(PROJECT);
    expect(
      hubApiRouteKey(getHubApiRoute("projects.setProjectUserRole")!, [
        { opts: { project_id: PROJECT } },
      ]),
    ).toBe(PROJECT);
    // a document's edit history lives with its project
    for (const name of ["sync.history", "sync.purgeHistory"]) {
      expect(
        hubApiRouteKey(getHubApiRoute(name)!, [
          { project_id: PROJECT, path: "a.txt" },
        ]),
      ).toBe(PROJECT);
    }
  });

  it("treats malformed keys as unroutable", () => {
    const route = getHubApiRoute("projects.setProjectMetadata")!;
    expect(hubApiRouteKey(route, [{ project_id: "x" }])).toBeUndefined();
    expect(hubApiRouteKey(route, [])).toBeUndefined();
  });

  it("finds a host method's host, and only for a host-scoped listing", () => {
    const log = getHubApiRoute("hosts.getHostLog")!;
    expect(log.owner).toBe("host");
    expect(hubApiRouteKey(log, [{ id: PROJECT }])).toBe(PROJECT);
    expect(hubApiRouteKey(log, [{ id: "x" }])).toBeUndefined();
    const deployments = getHubApiRoute("hosts.listHostRuntimeDeployments")!;
    expect(
      hubApiRouteKey(deployments, [{ scope_type: "host", id: PROJECT }]),
    ).toBe(PROJECT);
    // A global listing reads this bay's rows, whatever id it carries.
    expect(
      hubApiRouteKey(deployments, [{ scope_type: "global", id: PROJECT }]),
    ).toBeUndefined();
  });

  // Every method routed by host id. A method missing from the route table
  // would run on whichever bay received it and refuse with a stale route.
  const HOST_ROUTED = [
    "hosts.getHostLog",
    "hosts.getHostAvailability",
    "hosts.getHostRuntimeLog",
    "hosts.getHostMetricsHistory",
    "hosts.listHostRootfsImages",
    "hosts.getHostExamState",
    "hosts.listHostSshAuthorizedKeys",
    "hosts.listHostAccess",
    "hosts.getHostManagedComponentStatus",
    "hosts.setHostAccess",
    "hosts.removeHostAccess",
    "hosts.setHostProjectRamLimit",
    "hosts.setHostOwnerSpendLimits",
    "hosts.setHostPoolAccess",
    "hosts.annotateHostAvailabilityEvent",
    "hosts.addHostSshAuthorizedKey",
    "hosts.removeHostSshAuthorizedKey",
    "hosts.setHostPublicRouteMode",
    "hosts.setHostMaintenanceNotice",
    "hosts.pullHostRootfsImage",
    "hosts.deleteHostRootfsImage",
    "hosts.gcDeletedHostRootfsImages",
    "hosts.setHostExamConfig",
    "hosts.createHostExamRun",
    "hosts.rotateHostExamToken",
    "hosts.openHostExamRun",
    "hosts.updateHostExamDeadline",
    "hosts.increaseHostExamCapacity",
    "hosts.stopAndEraseHostExamRun",
    "hosts.reconcileHostRuntimeDeployments",
    "hosts.rollbackHostRuntimeDeployments",
    "hosts.reconcileHostSoftware",
    "hosts.startHost",
    "hosts.stopHost",
    "hosts.restartHost",
    "hosts.drainHost",
    "hosts.backupHostProjects",
    "hosts.deleteHost",
    "hosts.forceDeprovisionHost",
    "hosts.refreshHostCloudState",
    "hosts.removeSelfHostConnector",
    "hosts.setHostDeletionProtection",
    "hosts.relocateHost",
    "hosts.upgradeHostSoftware",
    "hosts.rolloutHostManagedComponents",
    "hosts.getHostRuntimeDeploymentStatus",
  ];

  it.each(HOST_ROUTED)("routes %s by its host id", (name) => {
    const route = getHubApiRoute(name);
    expect(route?.owner).toBe("host");
    expect(hubApiRouteKey(route!, [{ id: PROJECT }])).toBe(PROJECT);
    expect(hubApiRouteKey(route!, [{ id: "x" }])).toBeUndefined();
  });

  it("routes a host-scoped deployment change by host, a global one not at all", () => {
    const route = getHubApiRoute("hosts.setHostRuntimeDeployments")!;
    expect(route.owner).toBe("host");
    expect(hubApiRouteKey(route, [{ scope_type: "host", id: PROJECT }])).toBe(
      PROJECT,
    );
    expect(
      hubApiRouteKey(route, [{ scope_type: "global", id: PROJECT }]),
    ).toBeUndefined();
  });

  it.each(["lro.get", "lro.list"])(
    "routes %s by host only for a host's operations",
    (name) => {
      const route = getHubApiRoute(name)!;
      expect(route.owner).toBe("host");
      expect(
        hubApiRouteKey(route, [{ scope_type: "host", scope_id: PROJECT }]),
      ).toBe(PROJECT);
      // Any other scope, or none, runs where received.
      expect(
        hubApiRouteKey(route, [{ scope_type: "project", scope_id: PROJECT }]),
      ).toBeUndefined();
      expect(hubApiRouteKey(route, [{ op_id: PROJECT }])).toBeUndefined();
    },
  );

  it("finds an email invite by id or link token", () => {
    const route = getHubApiRoute("projects.redeemEmailProjectInvite")!;
    expect(route.owner).toBe("collab-invite");
    expect(hubApiRouteKey(route, [{ invite_id: PROJECT, token: "t" }])).toEqual(
      { invite_id: PROJECT, token: "t" },
    );
    expect(hubApiRouteKey(route, [{ token: "t" }])).toEqual({ token: "t" });
    // Neither a valid id nor a bounded token: unroutable.
    expect(hubApiRouteKey(route, [{ invite_id: "x" }])).toBeUndefined();
    expect(hubApiRouteKey(route, [{ token: "t".repeat(513) }])).toBeUndefined();
    expect(hubApiRouteKey(route, [{ token: 7 }])).toBeUndefined();
  });

  it("does not route other methods or prototype names", () => {
    expect(getHubApiRoute("projects.createProject")).toBeUndefined();
    expect(getHubApiRoute("toString")).toBeUndefined();
    expect(getHubApiRoute("constructor")).toBeUndefined();
  });
});
