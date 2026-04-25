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
  it("throws a local rollback error when project-host converges to the previous version", async () => {
    const initialRow = {
      id: "host-1",
      status: "running",
      version: "ph-v2",
      last_seen: new Date("2026-04-25T18:00:00.000Z"),
      metadata: {
        owner: "account-1",
        software: {
          project_host: "ph-v2",
        },
      },
    };
    const rolledBackRow = {
      ...initialRow,
      version: "ph-v1",
      last_seen: new Date("2026-04-25T18:01:00.000Z"),
      metadata: {
        owner: "account-1",
        software: {
          project_host: "ph-v1",
        },
      },
    };
    const loadHostForStartStop = jest
      .fn()
      .mockResolvedValueOnce(initialRow)
      .mockResolvedValueOnce(rolledBackRow);
    const automaticRollback = {
      host_id: "host-1",
      rollback_version: "ph-v1",
      source: "host-agent" as const,
    };
    const recordProjectHostLocalRollbackInternal = jest.fn(
      async () => automaticRollback,
    );

    await expect(
      rolloutHostManagedComponentsInternalHelper({
        account_id: "account-1",
        id: "host-1",
        components: ["project-host"],
        reason: "host_software_upgrade",
        loadHostForStartStop,
        assertHostRunningForUpgrade: () => undefined,
        hostControlClient: async () => ({
          getRuntimeLog: async ({ source }) => ({
            source: source ?? "project-host",
            lines: 25,
            text: "",
          }),
          rolloutManagedComponents: async () => ({
            results: [
              {
                component: "project-host",
                action: "restart_scheduled",
              },
            ],
          }),
        }),
        waitForHostHeartbeatAfter: async () => undefined,
        installedProjectHostArtifactVersion: (row) =>
          `${row?.metadata?.software?.project_host ?? row?.version ?? ""}`.trim() ||
          undefined,
        recordProjectHostLocalRollbackInternal,
        project_host_local_rollback_error_code: "PROJECT_HOST_LOCAL_ROLLBACK",
        setLastKnownGoodArtifactVersionInternal: async () => undefined,
        runtimeDeploymentsForComponentRollout: () => [],
        requestedByForRuntimeDeployments: () => "account-1",
        setProjectHostRuntimeDeployments: async () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "PROJECT_HOST_LOCAL_ROLLBACK",
      automaticRollback,
    });

    expect(loadHostForStartStop).toHaveBeenCalledTimes(2);
    expect(recordProjectHostLocalRollbackInternal).toHaveBeenCalledWith({
      account_id: "account-1",
      id: "host-1",
      version: "ph-v1",
      reason: "automatic_project_host_local_rollback",
    });
  });

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

  it("does not record a rollback when the restarted project-host is running the desired version", async () => {
    const loadHostForStartStop = jest
      .fn()
      .mockResolvedValueOnce({
        id: "host-1",
        status: "running",
        version: "ph-v2",
        last_seen: "2026-04-25T05:00:00.000Z",
        metadata: {
          owner: "account-1",
          software: {
            project_host: "ph-v2",
          },
        },
      })
      .mockResolvedValueOnce({
        id: "host-1",
        status: "running",
        version: "ph-v2",
        last_seen: "2026-04-25T05:00:05.000Z",
        metadata: {
          owner: "account-1",
          software: {
            project_host: "ph-v1",
          },
        },
      });
    const recordProjectHostLocalRollbackInternal = jest.fn(async () => ({
      host_id: "host-1",
      rollback_version: "ph-v1",
      source: "host-agent" as const,
    }));
    const setLastKnownGoodArtifactVersionInternal = jest.fn(
      async () => undefined,
    );

    await expect(
      rolloutHostManagedComponentsInternalHelper({
        account_id: "account-1",
        id: "host-1",
        components: ["project-host"],
        reason: "host_software_upgrade",
        loadHostForStartStop,
        assertHostRunningForUpgrade: () => undefined,
        hostControlClient: async () => ({
          getRuntimeLog: async () => ({
            source: "project-host",
            lines: 25,
            text: "",
          }),
          rolloutManagedComponents: async () => ({
            results: [
              {
                component: "project-host",
                action: "restart_scheduled",
                message: "scheduled project-host restart",
              },
            ],
          }),
          getManagedComponentStatus: async () => [
            {
              component: "project-host",
              artifact: "project-host",
              upgrade_policy: "restart_now",
              enabled: true,
              managed: true,
              desired_version: "ph-v2",
              runtime_state: "running",
              version_state: "aligned",
              running_versions: ["ph-v2"],
              running_pids: [123],
            },
          ],
        }),
        waitForHostHeartbeatAfter: async () => undefined,
        installedProjectHostArtifactVersion: () => "ph-v1",
        recordProjectHostLocalRollbackInternal,
        project_host_local_rollback_error_code: "project_host_local_rollback",
        setLastKnownGoodArtifactVersionInternal,
        runtimeDeploymentsForComponentRollout: () => [],
        requestedByForRuntimeDeployments: () => "account-1",
        setProjectHostRuntimeDeployments: async () => undefined,
      }),
    ).resolves.toEqual({
      results: [
        {
          component: "project-host",
          action: "restart_scheduled",
          message: "scheduled project-host restart",
        },
      ],
    });

    expect(recordProjectHostLocalRollbackInternal).not.toHaveBeenCalled();
    expect(setLastKnownGoodArtifactVersionInternal).toHaveBeenCalledWith(
      expect.objectContaining({
        host_id: "host-1",
        version: "ph-v2",
      }),
    );
  });

  it("uses bootstrap lifecycle observations before declaring a local rollback", async () => {
    const recordProjectHostLocalRollbackInternal = jest.fn(async () => ({
      host_id: "host-1",
      rollback_version: "ph-v1",
      source: "host-agent" as const,
    }));
    const setLastKnownGoodArtifactVersionInternal = jest.fn(
      async () => undefined,
    );

    await expect(
      rolloutHostManagedComponentsInternalHelper({
        account_id: "account-1",
        id: "host-1",
        components: ["project-host"],
        reason: "host_software_upgrade",
        loadHostForStartStop: jest
          .fn()
          .mockResolvedValueOnce({
            id: "host-1",
            status: "running",
            version: "ph-v2",
            last_seen: "2026-04-25T05:00:00.000Z",
            metadata: {
              owner: "account-1",
              software: {
                project_host: "ph-v2",
              },
            },
          })
          .mockResolvedValueOnce({
            id: "host-1",
            status: "running",
            version: "ph-v2",
            last_seen: "2026-04-25T05:00:05.000Z",
            metadata: {
              owner: "account-1",
              software: {
                project_host: "ph-v1",
              },
              bootstrap_lifecycle: {
                items: [
                  {
                    key: "project_host_bundle",
                    installed: "ph-v2",
                  },
                ],
              },
            },
          }),
        assertHostRunningForUpgrade: () => undefined,
        hostControlClient: async () => ({
          getRuntimeLog: async () => ({
            source: "project-host",
            lines: 25,
            text: "",
          }),
          rolloutManagedComponents: async () => ({
            results: [
              {
                component: "project-host",
                action: "restart_scheduled",
                message: "scheduled project-host restart",
              },
            ],
          }),
          getManagedComponentStatus: async () => {
            throw new Error("project-host still reconnecting");
          },
        }),
        waitForHostHeartbeatAfter: async () => undefined,
        installedProjectHostArtifactVersion: () => "ph-v1",
        recordProjectHostLocalRollbackInternal,
        project_host_local_rollback_error_code: "project_host_local_rollback",
        setLastKnownGoodArtifactVersionInternal,
        runtimeDeploymentsForComponentRollout: () => [],
        requestedByForRuntimeDeployments: () => "account-1",
        setProjectHostRuntimeDeployments: async () => undefined,
      }),
    ).resolves.toEqual({
      results: [
        {
          component: "project-host",
          action: "restart_scheduled",
          message: "scheduled project-host restart",
        },
      ],
    });

    expect(recordProjectHostLocalRollbackInternal).not.toHaveBeenCalled();
    expect(setLastKnownGoodArtifactVersionInternal).toHaveBeenCalledWith(
      expect.objectContaining({
        host_id: "host-1",
        version: "ph-v2",
      }),
    );
  });

  it("accepts the current project-host build id when it matches the desired artifact version", async () => {
    const desiredVersion = "1777132045702";
    const buildId = "20260425T154715Z-4db30a775993";
    const recordProjectHostLocalRollbackInternal = jest.fn(async () => ({
      host_id: "host-1",
      rollback_version: desiredVersion,
      source: "host-agent" as const,
    }));
    const setLastKnownGoodArtifactVersionInternal = jest.fn(
      async () => undefined,
    );

    await expect(
      rolloutHostManagedComponentsInternalHelper({
        account_id: "account-1",
        id: "host-1",
        components: ["project-host"],
        reason: "host_software_upgrade",
        loadHostForStartStop: jest
          .fn()
          .mockResolvedValueOnce({
            id: "host-1",
            status: "running",
            version: desiredVersion,
            last_seen: "2026-04-25T15:47:00.000Z",
            metadata: {
              owner: "account-1",
              software: {
                project_host: desiredVersion,
              },
            },
          })
          .mockResolvedValueOnce({
            id: "host-1",
            status: "running",
            version: desiredVersion,
            last_seen: "2026-04-25T15:47:10.000Z",
            metadata: {
              owner: "account-1",
              software: {
                project_host: desiredVersion,
                project_host_build_id: buildId,
              },
              software_inventory: [
                {
                  artifact: "project-host",
                  current_version: desiredVersion,
                  current_build_id: buildId,
                },
              ],
            },
          }),
        assertHostRunningForUpgrade: () => undefined,
        hostControlClient: async () => ({
          getRuntimeLog: async () => ({
            source: "project-host",
            lines: 25,
            text: "",
          }),
          rolloutManagedComponents: async () => ({
            results: [
              {
                component: "project-host",
                action: "restart_scheduled",
                message: "scheduled project-host restart",
              },
            ],
          }),
          getManagedComponentStatus: async () => [
            {
              component: "project-host",
              artifact: "project-host",
              upgrade_policy: "restart_now",
              enabled: true,
              managed: true,
              desired_version: buildId,
              runtime_state: "running",
              version_state: "aligned",
              running_versions: [buildId],
              running_pids: [123],
            },
          ],
        }),
        waitForHostHeartbeatAfter: async () => undefined,
        installedProjectHostArtifactVersion: () => desiredVersion,
        recordProjectHostLocalRollbackInternal,
        project_host_local_rollback_error_code: "project_host_local_rollback",
        setLastKnownGoodArtifactVersionInternal,
        runtimeDeploymentsForComponentRollout: () => [],
        requestedByForRuntimeDeployments: () => "account-1",
        setProjectHostRuntimeDeployments: async () => undefined,
      }),
    ).resolves.toEqual({
      results: [
        {
          component: "project-host",
          action: "restart_scheduled",
          message: "scheduled project-host restart",
        },
      ],
    });

    expect(recordProjectHostLocalRollbackInternal).not.toHaveBeenCalled();
    expect(setLastKnownGoodArtifactVersionInternal).toHaveBeenCalledWith(
      expect.objectContaining({
        host_id: "host-1",
        version: desiredVersion,
      }),
    );
  });
});
