/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  rolloutHostManagedComponentsInternalHelper,
  upgradeHostSoftwareInternalHelper,
} from "./hosts-software-execution";
import { runtimeDeploymentsForUpgradeResults } from "./hosts-runtime-deployment-planning";

let getServerSettingsMock: jest.Mock;

jest.mock("@cocalc/database/settings/server-settings", () => ({
  __esModule: true,
  getServerSettings: (...args: any[]) => getServerSettingsMock(...args),
}));

describe("upgradeHostSoftwareInternalHelper", () => {
  beforeEach(() => {
    getServerSettingsMock = jest.fn(async () => ({}));
  });

  it("realigns the full runtime stack on noop project-host upgrades when requested", async () => {
    const row = {
      id: "host-1",
      status: "running",
      version: "ph-v2",
      metadata: {
        owner: "account-1",
        software: {
          project_host: "ph-v2",
        },
      },
    };
    const setProjectHostRuntimeDeployments = jest.fn(async () => []);

    await expect(
      upgradeHostSoftwareInternalHelper({
        account_id: "account-1",
        id: "host-1",
        targets: [{ artifact: "project-host", channel: "latest" }],
        align_runtime_stack: true,
        loadHostForStartStop: async () => row,
        assertHostRunningForUpgrade: () => undefined,
        computeHostOperationalAvailability: () => ({ online: true }),
        resolveHostSoftwareBaseUrl: async () => undefined,
        resolveReachableUpgradeBaseUrl: async () => undefined,
        logWarn: () => undefined,
        reconcileCloudHostBootstrapOverSsh: async () => undefined,
        hostControlClient: async () => ({
          upgradeSoftware: async () => ({ results: [] }),
        }),
        updateProjectHostSoftwareRecord: async () => undefined,
        runtimeDeploymentsForUpgradeResults,
        requestedByForRuntimeDeployments: () => "account-1",
        setProjectHostRuntimeDeployments,
      }),
    ).resolves.toEqual({ results: [] });

    expect(setProjectHostRuntimeDeployments).toHaveBeenCalledWith(
      expect.objectContaining({
        scope_type: "host",
        host_id: "host-1",
        replace: false,
        deployments: expect.arrayContaining([
          {
            target_type: "artifact",
            target: "project-host",
            desired_version: "ph-v2",
          },
          expect.objectContaining({
            target_type: "component",
            target: "project-host",
            desired_version: "ph-v2",
          }),
          expect.objectContaining({
            target_type: "component",
            target: "conat-router",
            desired_version: "ph-v2",
          }),
          expect.objectContaining({
            target_type: "component",
            target: "conat-persist",
            desired_version: "ph-v2",
          }),
          expect.objectContaining({
            target_type: "component",
            target: "acp-worker",
            desired_version: "ph-v2",
          }),
        ]),
      }),
    );
  });

  it("sends control-plane retention policy to the host upgrader", async () => {
    const upgradeSoftware = jest.fn(async () => ({ results: [] }));

    await upgradeHostSoftwareInternalHelper({
      account_id: "account-1",
      id: "host-1",
      targets: [{ artifact: "project-host", channel: "latest" }],
      loadHostForStartStop: async () => ({
        id: "host-1",
        status: "running",
        metadata: { owner: "account-1" },
      }),
      assertHostRunningForUpgrade: () => undefined,
      computeHostOperationalAvailability: () => ({ online: true }),
      resolveHostSoftwareBaseUrl: async () => undefined,
      resolveReachableUpgradeBaseUrl: async () => undefined,
      logWarn: () => undefined,
      reconcileCloudHostBootstrapOverSsh: async () => undefined,
      hostControlClient: async () => ({
        upgradeSoftware,
      }),
      updateProjectHostSoftwareRecord: async () => undefined,
      runtimeDeploymentsForUpgradeResults,
      requestedByForRuntimeDeployments: () => "account-1",
      setProjectHostRuntimeDeployments: async () => undefined,
    });

    expect(upgradeSoftware).toHaveBeenCalledWith(
      expect.objectContaining({
        retention_policy: {
          "project-host": { keep_count: 10 },
          "project-bundle": { keep_count: 3 },
          tools: { keep_count: 3 },
        },
      }),
    );
  });

  it("uses durable server-side retention policy overrides", async () => {
    getServerSettingsMock.mockResolvedValue({
      project_hosts_runtime_retention_policy: {
        "project-host": { keep_count: 12, max_bytes: 1200 },
        "project-bundle": { keep_count: 4 },
        tools: { keep_count: 5, max_bytes: 5000 },
      },
    });
    const upgradeSoftware = jest.fn(async () => ({ results: [] }));

    await upgradeHostSoftwareInternalHelper({
      account_id: "account-1",
      id: "host-1",
      targets: [{ artifact: "project-host", channel: "latest" }],
      loadHostForStartStop: async () => ({
        id: "host-1",
        status: "running",
        metadata: { owner: "account-1" },
      }),
      assertHostRunningForUpgrade: () => undefined,
      computeHostOperationalAvailability: () => ({ online: true }),
      resolveHostSoftwareBaseUrl: async () => undefined,
      resolveReachableUpgradeBaseUrl: async () => undefined,
      logWarn: () => undefined,
      reconcileCloudHostBootstrapOverSsh: async () => undefined,
      hostControlClient: async () => ({
        upgradeSoftware,
      }),
      updateProjectHostSoftwareRecord: async () => undefined,
      runtimeDeploymentsForUpgradeResults,
      requestedByForRuntimeDeployments: () => "account-1",
      setProjectHostRuntimeDeployments: async () => undefined,
    });

    expect(upgradeSoftware).toHaveBeenCalledWith(
      expect.objectContaining({
        retention_policy: {
          "project-host": { keep_count: 12, max_bytes: 1200 },
          "project-bundle": { keep_count: 4 },
          tools: { keep_count: 5, max_bytes: 5000 },
        },
      }),
    );
  });
});

describe("rolloutHostManagedComponentsInternalHelper", () => {
  it("appends recent host diagnostics when managed component rollout fails", async () => {
    await expect(
      rolloutHostManagedComponentsInternalHelper({
        account_id: "account-1",
        id: "host-1",
        components: ["conat-router"],
        reason: "host_software_upgrade",
        loadHostForStartStop: async () => ({
          id: "host-1",
          status: "running",
          metadata: {
            owner: "account-1",
            software: {
              project_host: "ph-v1",
            },
          },
        }),
        assertHostRunningForUpgrade: () => undefined,
        hostControlClient: async () => ({
          getRuntimeLog: async ({ source }) => ({
            source: source ?? "project-host",
            lines: 25,
            text:
              source === "supervision-events"
                ? '{"component":"conat-router","action":"missing_process"}'
                : "router crashed during startup",
          }),
          rolloutManagedComponents: async () => {
            throw new Error(
              "project-host conat router exited before becoming healthy",
            );
          },
        }),
        waitForHostHeartbeatAfter: async () => undefined,
        installedProjectHostArtifactVersion: () => "ph-v1",
        recordProjectHostLocalRollbackInternal: async () => ({
          host_id: "host-1",
          rollback_version: "ph-v1",
          source: "host-agent",
        }),
        project_host_local_rollback_error_code: "project_host_local_rollback",
        setLastKnownGoodArtifactVersionInternal: async () => undefined,
        runtimeDeploymentsForComponentRollout: () => [],
        requestedByForRuntimeDeployments: () => "account-1",
        setProjectHostRuntimeDeployments: async () => undefined,
      }),
    ).rejects.toThrow(
      /Recent host diagnostics:[\s\S]*\[supervision-events\][\s\S]*\[conat-router\]/,
    );
  });
});
