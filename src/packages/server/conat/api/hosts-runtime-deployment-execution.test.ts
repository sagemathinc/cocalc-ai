/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { rollbackHostRuntimeDeploymentsInternalHelper } from "./hosts-runtime-deployment-execution";

describe("rollbackHostRuntimeDeploymentsInternalHelper", () => {
  it("rolls back bootstrap-environment by reconciling bootstrap over ssh", async () => {
    const row = {
      id: "host-1",
      status: "running",
      metadata: {
        machine: {
          cloud: "gcp",
          metadata: {
            public_ip: "1.2.3.4",
            ssh_user: "ubuntu",
          },
        },
      },
    };
    const setProjectHostRuntimeDeployments = jest.fn(async () => [
      {
        target_type: "artifact",
        target: "bootstrap-environment",
        desired_version: "bootstrap-v1",
      },
    ]);
    const assertCloudHostBootstrapReconcileSupported = jest.fn();
    const reconcileCloudHostBootstrapOverSsh = jest.fn(async () => undefined);
    const upgradeHostSoftwareInternal = jest.fn();
    const reconcileProjectHostComponent = jest.fn();
    const rolloutProjectHostArtifact = jest.fn();

    const result = await rollbackHostRuntimeDeploymentsInternalHelper({
      account_id: "account-1",
      id: "host-1",
      target_type: "artifact",
      target: "bootstrap-environment",
      last_known_good: true,
      reason: "test bootstrap rollback",
      loadHostForStartStop: async () => row,
      assertHostRunningForUpgrade: () => undefined,
      getHostRuntimeDeploymentStatus: async () => ({
        effective: [
          {
            target_type: "artifact",
            target: "bootstrap-environment",
            desired_version: "bootstrap-v2",
          },
        ],
        rollback_targets: [
          {
            target_type: "artifact",
            target: "bootstrap-environment",
            artifact: "bootstrap-environment",
            desired_version: "bootstrap-v2",
            last_known_good_version: "bootstrap-v1",
            retained_versions: [],
          },
        ],
      }),
      targetKeyForRuntimeDeployment: ({ target_type, target }) =>
        `${target_type}:${target}`,
      resolveRollbackVersion: ({ rollbackTarget, last_known_good }) => ({
        rollback_version: last_known_good
          ? rollbackTarget.last_known_good_version
          : "bootstrap-v0",
        rollback_source: last_known_good
          ? "last_known_good"
          : "explicit_version",
      }),
      requestedByForRuntimeDeployments: () => "tester",
      setProjectHostRuntimeDeployments,
      upgradeHostSoftwareInternal,
      reconcileProjectHostComponent,
      rolloutProjectHostArtifact,
      assertCloudHostBootstrapReconcileSupported,
      reconcileCloudHostBootstrapOverSsh,
    });

    expect(result).toEqual({
      host_id: "host-1",
      target_type: "artifact",
      target: "bootstrap-environment",
      artifact: "bootstrap-environment",
      rollback_version: "bootstrap-v1",
      rollback_source: "last_known_good",
      deployment: {
        target_type: "artifact",
        target: "bootstrap-environment",
        desired_version: "bootstrap-v1",
      },
    });
    expect(setProjectHostRuntimeDeployments).toHaveBeenCalledWith(
      expect.objectContaining({
        scope_type: "host",
        host_id: "host-1",
        deployments: [
          expect.objectContaining({
            target_type: "artifact",
            target: "bootstrap-environment",
            desired_version: "bootstrap-v1",
            rollout_reason: "test bootstrap rollback",
          }),
        ],
      }),
    );
    expect(assertCloudHostBootstrapReconcileSupported).toHaveBeenCalledWith(
      row,
    );
    expect(reconcileCloudHostBootstrapOverSsh).toHaveBeenCalledWith({
      host_id: "host-1",
      row,
    });
    expect(upgradeHostSoftwareInternal).not.toHaveBeenCalled();
    expect(reconcileProjectHostComponent).not.toHaveBeenCalled();
    expect(rolloutProjectHostArtifact).not.toHaveBeenCalled();
  });
});
