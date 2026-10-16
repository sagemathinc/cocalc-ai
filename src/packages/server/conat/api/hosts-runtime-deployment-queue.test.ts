/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  ensureAutomaticHostArtifactDeploymentsReconcileInternal,
  ensureAutomaticHostRuntimeDeploymentsReconcileInternal,
  hostSoftwareChangeOpInFlight,
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

describe("which upgrade ops count as in flight", () => {
  const now = Date.parse("2026-10-15T05:00:00Z");
  const ago = (ms: number) => new Date(now - ms);

  it("keeps a running op in flight while its worker heartbeats, however old it is", () => {
    // Queued for 30 min behind other host ops, then claimed just now.
    expect(
      hostSoftwareChangeOpInFlight(
        {
          status: "running",
          created_at: ago(30 * 60_000),
          started_at: ago(20_000),
          heartbeat_at: ago(10_000),
        },
        now,
      ),
    ).toBe(true);
    expect(
      hostSoftwareChangeOpInFlight(
        {
          status: "running",
          created_at: ago(3 * 3600_000),
          started_at: ago(2 * 3600_000),
          heartbeat_at: ago(15_000),
        },
        now,
      ),
    ).toBe(true);
  });

  it("stops counting a running op whose worker stopped heartbeating", () => {
    expect(
      hostSoftwareChangeOpInFlight(
        {
          status: "running",
          created_at: ago(10 * 60_000),
          started_at: ago(10 * 60_000),
          heartbeat_at: ago(5 * 60_000),
        },
        now,
      ),
    ).toBe(false);
  });

  it("bounds a queued op by its queue age", () => {
    expect(
      hostSoftwareChangeOpInFlight(
        { status: "queued", created_at: ago(5 * 60_000) },
        now,
      ),
    ).toBe(true);
    expect(
      hostSoftwareChangeOpInFlight(
        { status: "queued", created_at: ago(25 * 60_000) },
        now,
      ),
    ).toBe(false);
  });
});
