/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { rollbackHostRuntimeDeploymentsInternalHelper } from "./hosts-runtime-deployment-execution";

describe("rollbackHostRuntimeDeploymentsInternalHelper", () => {
  const targetKeyForRuntimeDeployment = ({ target_type, target }) =>
    `${target_type}:${target}`;
  const resolveRollbackVersion = ({ rollbackTarget, last_known_good }) => ({
    rollback_version: last_known_good
      ? rollbackTarget.last_known_good_version
      : (rollbackTarget.previous_version ?? "project-host-v1"),
    rollback_source: last_known_good ? "last_known_good" : "previous_version",
  });

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
      targetKeyForRuntimeDeployment,
      resolveRollbackVersion,
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

  it("does not rewrite component desired state when artifact preflight fails", async () => {
    const setProjectHostRuntimeDeployments = jest.fn();
    const upgradeHostSoftwareInternal = jest.fn(async () => {
      throw new Error("artifact unavailable");
    });

    await expect(
      rollbackHostRuntimeDeploymentsInternalHelper({
        account_id: "account-1",
        id: "host-1",
        target_type: "component",
        target: "project-host",
        reason: "test failed rollback",
        loadHostForStartStop: async () => ({ id: "host-1", status: "running" }),
        assertHostRunningForUpgrade: () => undefined,
        getHostRuntimeDeploymentStatus: async () => ({
          effective: [
            {
              target_type: "component",
              target: "project-host",
              desired_version: "project-host-v2",
              rollout_policy: "restart_now",
            },
          ],
          rollback_targets: [
            {
              target_type: "component",
              target: "project-host",
              artifact: "project-host",
              current_version: "project-host-v2",
              previous_version: "project-host-v1",
            },
          ],
        }),
        targetKeyForRuntimeDeployment,
        resolveRollbackVersion,
        requestedByForRuntimeDeployments: () => "tester",
        setProjectHostRuntimeDeployments,
        upgradeHostSoftwareInternal,
        reconcileProjectHostComponent: jest.fn(),
        rolloutProjectHostArtifact: jest.fn(),
        assertCloudHostBootstrapReconcileSupported: jest.fn(),
        reconcileCloudHostBootstrapOverSsh: jest.fn(),
      }),
    ).rejects.toThrow("artifact unavailable");

    expect(upgradeHostSoftwareInternal).toHaveBeenCalledWith({
      account_id: "account-1",
      id: "host-1",
      targets: [{ artifact: "project-host", version: "project-host-v1" }],
    });
    expect(setProjectHostRuntimeDeployments).not.toHaveBeenCalled();
  });
});
