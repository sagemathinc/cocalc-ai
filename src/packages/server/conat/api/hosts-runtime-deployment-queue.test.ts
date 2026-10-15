/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  ensureAutomaticHostArtifactDeploymentsReconcileInternal,
  ensureAutomaticHostRuntimeDeploymentsReconcileInternal,
} from "./hosts-runtime-deployment-queue";

// The host reports project-host at the new version while the effective
// desired version is still the old global one (the upgrade has not recorded
// its target yet).
const row = { id: "host-1", status: "running", metadata: {} };
const status = {
  effective: [
    {
      target_type: "artifact",
      target: "project-host",
      desired_version: "old",
      requested_by: "account-1",
    },
  ],
  observed_artifacts: [{ artifact: "project-host", version: "new" }],
};

function artifactDeps(hostUpgradeInFlight?: () => Promise<boolean>) {
  return {
    host_id: "host-1",
    running_statuses: new Set(["running"]),
    loadHostRowForRuntimeDeploymentsInternal: jest.fn(async () => row),
    getHostRuntimeDeploymentStatusInternal: jest.fn(async () => status),
    computeAutomaticArtifactUpgradeTargets: jest.fn(() => [
      { artifact: "project-host" as const, version: "old" },
    ]),
    createHostLro: jest.fn(async () => ({ op_id: "op-1" })),
    hostUpgradeDedupeKey: jest.fn(() => "dedupe"),
    upgrade_lro_kind: "host-upgrade-software" as any,
    hostUpgradeInFlight,
  };
}

function runtimeDeps(hostUpgradeInFlight?: () => Promise<boolean>) {
  return {
    host_id: "host-1",
    reason: "host_register",
    running_statuses: new Set(["running"]),
    loadHostRowForRuntimeDeploymentsInternal: jest.fn(async () => row),
    getHostRuntimeDeploymentStatusInternal: jest.fn(async () => ({
      effective: [],
      observed_components: [{ component: "project-host" }],
    })),
    computeHostRuntimeDeploymentReconcilePlan: jest.fn(() => ({
      reconciled_components: ["project-host" as const],
    })),
    createHostLro: jest.fn(async () => ({ op_id: "op-2" })),
    normalizeManagedComponentKindsForDedupe: (components: any[]) => components,
    reconcile_lro_kind: "host-reconcile-runtime-deployments" as any,
    automatic_reason: "automatic_runtime_deployment_reconcile",
    hostUpgradeInFlight,
  };
}

describe("automatic convergence while a host upgrade is in flight", () => {
  it("does not revert an artifact the in-flight upgrade has not recorded yet", async () => {
    const deps = artifactDeps(async () => true);
    await expect(
      ensureAutomaticHostArtifactDeploymentsReconcileInternal(deps),
    ).resolves.toEqual({
      queued: false,
      host_id: "host-1",
      reason: "host_upgrade_in_flight",
    });
    expect(deps.getHostRuntimeDeploymentStatusInternal).not.toHaveBeenCalled();
    expect(deps.createHostLro).not.toHaveBeenCalled();
  });

  it("converges artifacts as before once no upgrade is in flight", async () => {
    const deps = artifactDeps(async () => false);
    await expect(
      ensureAutomaticHostArtifactDeploymentsReconcileInternal(deps),
    ).resolves.toMatchObject({ queued: true, op_id: "op-1" });
    expect(deps.createHostLro).toHaveBeenCalledTimes(1);
  });

  it("does not reconcile runtime components while an upgrade is in flight", async () => {
    const deps = runtimeDeps(async () => true);
    await expect(
      ensureAutomaticHostRuntimeDeploymentsReconcileInternal(deps),
    ).resolves.toEqual({
      queued: false,
      host_id: "host-1",
      reason: "host_upgrade_in_flight",
    });
    expect(deps.createHostLro).not.toHaveBeenCalled();

    const idle = runtimeDeps(async () => false);
    await expect(
      ensureAutomaticHostRuntimeDeploymentsReconcileInternal(idle),
    ).resolves.toMatchObject({ queued: true, op_id: "op-2" });
  });
});
