/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  __test__,
  rolloutHostManagedComponentsInternalHelper,
  upgradeHostSoftwareInternalHelper,
} from "./hosts-software-execution";
import { runtimeDeploymentsForUpgradeResults } from "./hosts-runtime-deployment-planning";

let getServerSettingsMock: jest.Mock;
let originalFetch: typeof globalThis.fetch | undefined;

function projectHostStatus({
  desiredVersion,
  runningVersion = desiredVersion,
  pid,
  versionState = runningVersion === desiredVersion ? "aligned" : "drifted",
}: {
  desiredVersion: string;
  runningVersion?: string;
  pid: number;
  versionState?: "aligned" | "drifted";
}) {
  return {
    component: "project-host" as const,
    artifact: "project-host" as const,
    upgrade_policy: "restart_now" as const,
    enabled: true,
    managed: true,
    desired_version: desiredVersion,
    runtime_state: "running" as const,
    version_state: versionState,
    running_versions: [runningVersion],
    running_pids: [pid],
  };
}

describe("managed component convergence", () => {
  const row = {
    version: "artifact-v1",
    metadata: { software: { project_host: "artifact-v1" } },
  };

  test("accepts a desired ACP worker while old workers drain", () => {
    expect(
      __test__.managedComponentAlignmentFailures({
        statuses: [
          {
            component: "acp-worker",
            artifact: "project-host",
            upgrade_policy: "drain_then_replace",
            enabled: true,
            managed: true,
            desired_version: "build-v2",
            runtime_state: "running",
            version_state: "mixed",
            running_versions: ["build-v1", "build-v2"],
            running_pids: [111, 222],
          },
        ],
        components: ["acp-worker"],
        desiredVersion: "artifact-v2",
        row,
      }),
    ).toEqual([]);
  });

  test("rejects mixed ACP workers when the desired worker is absent", () => {
    expect(
      __test__.managedComponentAlignmentFailures({
        statuses: [
          {
            component: "acp-worker",
            artifact: "project-host",
            upgrade_policy: "drain_then_replace",
            enabled: true,
            managed: true,
            desired_version: "build-v2",
            runtime_state: "running",
            version_state: "mixed",
            running_versions: ["build-v0", "build-v1"],
            running_pids: [111, 222],
          },
        ],
        components: ["acp-worker"],
        desiredVersion: "artifact-v2",
        row,
      }),
    ).toEqual([
      "acp-worker: version_state=mixed, running=build-v0,build-v1, desired=build-v2",
    ]);
  });
});

jest.mock("@cocalc/database/settings/server-settings", () => ({
  __esModule: true,
  getServerSettings: (...args: any[]) => getServerSettingsMock(...args),
}));

describe("upgradeHostSoftwareInternalHelper", () => {
  beforeEach(() => {
    getServerSettingsMock = jest.fn(async () => ({}));
    originalFetch = global.fetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalFetch) {
      global.fetch = originalFetch;
    } else {
      delete (global as any).fetch;
    }
  });

  it("preflights host-control before running direct artifact upgrades", async () => {
    const waitFor = jest.fn(async () => ["pong"]);
    const upgradeSoftware = jest.fn(async () => ({
      results: [
        {
          artifact: "project" as const,
          version: "project-v1",
          status: "noop" as const,
        },
      ],
    }));
    const onProgress = jest.fn();

    await expect(
      upgradeHostSoftwareInternalHelper({
        account_id: "account-1",
        id: "host-1",
        targets: [{ artifact: "project", channel: "latest" }],
        loadHostForStartStop: async () => ({
          id: "host-1",
          status: "running",
          metadata: {
            owner: "account-1",
          },
        }),
        assertHostRunningForUpgrade: () => undefined,
        computeHostOperationalAvailability: () => ({ online: true }),
        resolveHostSoftwareBaseUrl: async () => undefined,
        resolveReachableUpgradeBaseUrl: async () => undefined,
        logWarn: () => undefined,
        reconcileCloudHostBootstrapOverSsh: async () => undefined,
        hostControlClient: async () => ({
          conat: { waitFor },
          upgradeSoftware,
        }),
        updateProjectHostSoftwareRecord: async () => undefined,
        runtimeDeploymentsForUpgradeResults,
        requestedByForRuntimeDeployments: () => "account-1",
        setProjectHostRuntimeDeployments: async () => [],
        onProgress,
      }),
    ).resolves.toEqual({
      results: [
        {
          artifact: "project",
          version: "project-v1",
          status: "noop",
        },
      ],
    });

    expect(waitFor).toHaveBeenCalledWith({ maxWait: 8000 });
    expect(upgradeSoftware).toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        rollout_phase: "host_control.preflight",
      }),
    );
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        rollout_phase: "host_control.ready",
      }),
    );
  });

  it("fails direct non-project-host upgrades quickly when host-control preflight fails", async () => {
    const reconcileCloudHostBootstrapOverSsh = jest.fn(async () => undefined);
    const upgradeSoftware = jest.fn();

    await expect(
      upgradeHostSoftwareInternalHelper({
        account_id: "account-1",
        id: "host-1",
        targets: [{ artifact: "project", channel: "latest" }],
        loadHostForStartStop: async () => ({
          id: "host-1",
          status: "running",
          metadata: {
            owner: "account-1",
          },
        }),
        assertHostRunningForUpgrade: () => undefined,
        computeHostOperationalAvailability: () => ({ online: true }),
        resolveHostSoftwareBaseUrl: async () => undefined,
        resolveReachableUpgradeBaseUrl: async () => undefined,
        logWarn: () => undefined,
        reconcileCloudHostBootstrapOverSsh,
        hostControlClient: async () => ({
          conat: {
            waitFor: async () => {
              throw new Error("no services matching");
            },
          },
          upgradeSoftware,
        }),
        updateProjectHostSoftwareRecord: async () => undefined,
        runtimeDeploymentsForUpgradeResults,
        requestedByForRuntimeDeployments: () => "account-1",
        setProjectHostRuntimeDeployments: async () => [],
      }),
    ).rejects.toThrow(/host-control service unavailable/);

    expect(upgradeSoftware).not.toHaveBeenCalled();
    expect(reconcileCloudHostBootstrapOverSsh).not.toHaveBeenCalled();
  });

  it("uses bootstrap reconcile fallback for latest project-host preflight failures", async () => {
    const reconcileCloudHostBootstrapOverSsh = jest.fn(async () => undefined);
    const logWarn = jest.fn();

    await expect(
      upgradeHostSoftwareInternalHelper({
        account_id: "account-1",
        id: "host-1",
        targets: [{ artifact: "project-host", channel: "latest" }],
        loadHostForStartStop: async () => ({
          id: "host-1",
          status: "running",
          metadata: {
            owner: "account-1",
          },
        }),
        assertHostRunningForUpgrade: () => undefined,
        computeHostOperationalAvailability: () => ({ online: true }),
        resolveHostSoftwareBaseUrl: async () => undefined,
        resolveReachableUpgradeBaseUrl: async () => undefined,
        logWarn,
        reconcileCloudHostBootstrapOverSsh,
        hostControlClient: async () => ({
          conat: {
            waitFor: async () => {
              throw new Error("no services matching");
            },
          },
          upgradeSoftware: async () => {
            throw new Error("should not call upgrade after failed preflight");
          },
        }),
        updateProjectHostSoftwareRecord: async () => undefined,
        runtimeDeploymentsForUpgradeResults,
        requestedByForRuntimeDeployments: () => "account-1",
        setProjectHostRuntimeDeployments: async () => [],
      }),
    ).resolves.toEqual({ results: [] });

    expect(reconcileCloudHostBootstrapOverSsh).toHaveBeenCalledWith({
      host_id: "host-1",
      row: expect.objectContaining({ id: "host-1" }),
    });
    expect(logWarn).toHaveBeenCalledWith(
      "host upgrade: host control upgrade failed; retry via ssh",
      expect.objectContaining({
        host_id: "host-1",
      }),
    );
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

  it("can realign project-host upgrades without recording host-scoped desired state", async () => {
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
        record_runtime_deployments: false,
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

    expect(setProjectHostRuntimeDeployments).not.toHaveBeenCalled();
  });

  it("uses the installed project-host artifact version when upgrade results report a build id", async () => {
    const loadHostForStartStop = jest
      .fn()
      .mockResolvedValueOnce({
        id: "host-1",
        status: "running",
        version: "1777603320059",
        metadata: {
          owner: "account-1",
          software: {
            project_host: "1777603320059",
          },
        },
      })
      .mockResolvedValueOnce({
        id: "host-1",
        status: "running",
        version: "1777603320059",
        metadata: {
          owner: "account-1",
          software: {
            project_host: "1777603320059",
            project_host_build_id:
              "20260501T024149Z-d8da8fa36b1e-dirty-789d9dbc",
          },
          software_inventory: [
            {
              artifact: "project-host",
              current_version: "1777603320059",
              current_build_id: "20260501T024149Z-d8da8fa36b1e-dirty-789d9dbc",
            },
          ],
        },
      });
    const setProjectHostRuntimeDeployments = jest.fn(async () => []);

    await expect(
      upgradeHostSoftwareInternalHelper({
        account_id: "account-1",
        id: "host-1",
        targets: [{ artifact: "project-host", channel: "latest" }],
        align_runtime_stack: true,
        loadHostForStartStop,
        assertHostRunningForUpgrade: () => undefined,
        computeHostOperationalAvailability: () => ({ online: true }),
        resolveHostSoftwareBaseUrl: async () => undefined,
        resolveReachableUpgradeBaseUrl: async () => undefined,
        logWarn: () => undefined,
        reconcileCloudHostBootstrapOverSsh: async () => undefined,
        hostControlClient: async () => ({
          upgradeSoftware: async () => ({
            results: [
              {
                artifact: "project-host",
                version: "20260501T024149Z-d8da8fa36b1e-dirty-789d9dbc",
                status: "updated",
              },
            ],
          }),
        }),
        updateProjectHostSoftwareRecord: async () => undefined,
        runtimeDeploymentsForUpgradeResults,
        requestedByForRuntimeDeployments: () => "account-1",
        setProjectHostRuntimeDeployments,
      }),
    ).resolves.toEqual({
      results: [
        {
          artifact: "project-host",
          version: "20260501T024149Z-d8da8fa36b1e-dirty-789d9dbc",
          status: "updated",
        },
      ],
    });

    expect(loadHostForStartStop).toHaveBeenCalledTimes(2);
    expect(setProjectHostRuntimeDeployments).toHaveBeenCalledWith(
      expect.objectContaining({
        scope_type: "host",
        host_id: "host-1",
        replace: false,
        deployments: expect.arrayContaining([
          {
            target_type: "artifact",
            target: "project-host",
            desired_version: "1777603320059",
          },
          expect.objectContaining({
            target_type: "component",
            target: "project-host",
            desired_version: "1777603320059",
          }),
        ]),
      }),
    );
  });

  it("emits structured artifact-installation progress for project-host upgrades", async () => {
    const onProgress = jest.fn();

    await expect(
      upgradeHostSoftwareInternalHelper({
        account_id: "account-1",
        id: "host-1",
        targets: [{ artifact: "project-host", version: "ph-v2" }],
        align_runtime_stack: true,
        loadHostForStartStop: async () => ({
          id: "host-1",
          status: "running",
          version: "ph-v1",
          metadata: {
            owner: "account-1",
            software: {
              project_host: "ph-v1",
            },
          },
        }),
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
        setProjectHostRuntimeDeployments: async () => [],
        onProgress,
      }),
    ).resolves.toEqual({ results: [] });

    expect(onProgress).toHaveBeenCalledWith({
      rollout_phase: "artifact.installing",
      rollout_phase_label: "Downloading/installing artifact",
      rollout_phase_owner: "artifact installation",
      rollout_target_version: "ph-v2",
    });
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

  it("treats bootstrap-environment as a reconcile-only upgrade target", async () => {
    const upgradeSoftware = jest.fn(async () => ({ results: [] }));
    const reconcileCloudHostBootstrapOverSsh = jest.fn(async () => undefined);
    const setProjectHostRuntimeDeployments = jest.fn(async () => []);
    global.fetch = jest.fn(async () => ({
      ok: true,
      text: async () => "bootstrap-sha-20260430  bootstrap.py\n",
    })) as any;

    await expect(
      upgradeHostSoftwareInternalHelper({
        account_id: "account-1",
        id: "host-1",
        targets: [{ artifact: "bootstrap-environment", channel: "latest" }],
        loadHostForStartStop: async () => ({
          id: "host-1",
          status: "running",
          metadata: { owner: "account-1" },
        }),
        assertHostRunningForUpgrade: () => undefined,
        computeHostOperationalAvailability: () => ({ online: true }),
        resolveHostSoftwareBaseUrl: async () =>
          "https://software.example.invalid/software",
        resolveReachableUpgradeBaseUrl: async () =>
          "https://software.example.invalid/software",
        logWarn: () => undefined,
        reconcileCloudHostBootstrapOverSsh,
        hostControlClient: async () => ({
          upgradeSoftware,
        }),
        updateProjectHostSoftwareRecord: async () => undefined,
        runtimeDeploymentsForUpgradeResults,
        requestedByForRuntimeDeployments: () => "account-1",
        setProjectHostRuntimeDeployments,
      }),
    ).resolves.toEqual({
      results: [
        {
          artifact: "bootstrap-environment",
          version: "bootstrap-sha-20260430",
          status: "updated",
        },
      ],
    });

    expect(upgradeSoftware).not.toHaveBeenCalled();
    expect(setProjectHostRuntimeDeployments).toHaveBeenCalledWith(
      expect.objectContaining({
        scope_type: "host",
        host_id: "host-1",
        replace: false,
        deployments: expect.arrayContaining([
          {
            target_type: "artifact",
            target: "bootstrap-environment",
            desired_version: "bootstrap-sha-20260430",
          },
        ]),
      }),
    );
    expect(reconcileCloudHostBootstrapOverSsh).toHaveBeenCalledWith({
      host_id: "host-1",
      row: expect.objectContaining({ id: "host-1" }),
    });
  });

  it("does not reconcile bootstrap-environment when the installed bootstrap already matches", async () => {
    const upgradeSoftware = jest.fn(async () => ({ results: [] }));
    const reconcileCloudHostBootstrapOverSsh = jest.fn(async () => undefined);
    const setProjectHostRuntimeDeployments = jest.fn(async () => []);
    const updateProjectHostSoftwareRecord = jest.fn(async () => undefined);
    global.fetch = jest.fn(async () => ({
      ok: true,
      text: async () =>
        "365e2c415f1fbed7eec7c12fd8d79db4c6c0f6ea64e8f599ca2f673557d8cd28  bootstrap.py\n",
    })) as any;

    await expect(
      upgradeHostSoftwareInternalHelper({
        account_id: "account-1",
        id: "host-1",
        targets: [{ artifact: "bootstrap-environment", channel: "latest" }],
        loadHostForStartStop: async () => ({
          id: "host-1",
          status: "running",
          metadata: {
            owner: "account-1",
            bootstrap_lifecycle: {
              items: [
                {
                  key: "bootstrap",
                  installed: "365e2c415f1f",
                },
              ],
            },
          },
        }),
        assertHostRunningForUpgrade: () => undefined,
        computeHostOperationalAvailability: () => ({ online: true }),
        resolveHostSoftwareBaseUrl: async () =>
          "https://software.example.invalid/software",
        resolveReachableUpgradeBaseUrl: async () =>
          "https://software.example.invalid/software",
        logWarn: () => undefined,
        reconcileCloudHostBootstrapOverSsh,
        hostControlClient: async () => ({
          upgradeSoftware,
        }),
        updateProjectHostSoftwareRecord,
        runtimeDeploymentsForUpgradeResults,
        requestedByForRuntimeDeployments: () => "account-1",
        setProjectHostRuntimeDeployments,
      }),
    ).resolves.toEqual({
      results: [
        {
          artifact: "bootstrap-environment",
          version:
            "365e2c415f1fbed7eec7c12fd8d79db4c6c0f6ea64e8f599ca2f673557d8cd28",
          status: "noop",
        },
      ],
    });

    expect(upgradeSoftware).not.toHaveBeenCalled();
    expect(updateProjectHostSoftwareRecord).not.toHaveBeenCalled();
    expect(setProjectHostRuntimeDeployments).not.toHaveBeenCalled();
    expect(reconcileCloudHostBootstrapOverSsh).not.toHaveBeenCalled();
  });
});

describe("rolloutHostManagedComponentsInternalHelper", () => {
  it("throws a local rollback error when project-host converges to the previous version", async () => {
    const rollbackStartedAt = new Date(Date.now() + 1_000).toISOString();
    const rollbackFinishedAt = new Date(Date.now() + 2_000).toISOString();
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
        software_inventory: [
          {
            artifact: "project-host",
            current_version: "ph-v1",
          },
        ],
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
        base_url: "https://hub.example.test/software",
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
          getManagedComponentStatus: async () => [
            {
              component: "project-host",
              artifact: "project-host",
              upgrade_policy: "restart_now",
              enabled: true,
              managed: true,
              desired_version: "ph-v2",
              runtime_state: "running",
              version_state: "drifted",
              running_versions: ["ph-v1"],
              running_pids: [123],
            },
          ],
          getHostAgentStatus: async () => ({
            project_host: {
              last_known_good_version: "ph-v1",
              last_automatic_rollback: {
                target_version: "ph-v2",
                rollback_version: "ph-v1",
                started_at: rollbackStartedAt,
                finished_at: rollbackFinishedAt,
                reason: "health_deadline_exceeded",
              },
            },
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
        loadEffectiveRuntimeDeployments: async () => [],
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

  it("ignores a rollback record from an earlier rollout of the same version", async () => {
    const desiredVersion = "ph-v2";
    const row = {
      id: "host-1",
      status: "running",
      version: desiredVersion,
      last_seen: new Date(),
      metadata: {
        owner: "account-1",
        software: {
          project_host: desiredVersion,
        },
      },
    };
    const recordProjectHostLocalRollbackInternal = jest.fn();
    const setLastKnownGoodArtifactVersionInternal = jest.fn(
      async () => undefined,
    );
    const rolloutManagedComponents = jest.fn(async () => ({
      results: [
        {
          component: "project-host" as const,
          action: "restart_scheduled" as const,
        },
      ],
    }));
    const getManagedComponentStatus = jest
      .fn()
      .mockResolvedValueOnce([projectHostStatus({ desiredVersion, pid: 123 })])
      .mockResolvedValue([projectHostStatus({ desiredVersion, pid: 456 })]);

    await expect(
      rolloutHostManagedComponentsInternalHelper({
        account_id: "account-1",
        id: "host-1",
        components: ["project-host"],
        reason: "host_software_upgrade",
        loadHostForStartStop: async () => row,
        assertHostRunningForUpgrade: () => undefined,
        hostControlClient: async () => ({
          getRuntimeLog: async ({ source }) => ({
            source: source ?? "project-host",
            lines: 25,
            text: "",
          }),
          rolloutManagedComponents,
          getManagedComponentStatus,
          getHostAgentStatus: async () => ({
            project_host: {
              last_known_good_version: "ph-v1",
              last_automatic_rollback: {
                target_version: desiredVersion,
                rollback_version: "ph-v1",
                started_at: "2026-07-16T12:00:00.000Z",
                finished_at: "2026-07-16T12:02:00.000Z",
                reason: "health_deadline_exceeded",
              },
            },
          }),
        }),
        waitForHostHeartbeatAfter: async () => undefined,
        installedProjectHostArtifactVersion: () => desiredVersion,
        recordProjectHostLocalRollbackInternal,
        project_host_local_rollback_error_code: "PROJECT_HOST_LOCAL_ROLLBACK",
        setLastKnownGoodArtifactVersionInternal,
        runtimeDeploymentsForComponentRollout: () => [],
        requestedByForRuntimeDeployments: () => "account-1",
        setProjectHostRuntimeDeployments: async () => undefined,
        loadEffectiveRuntimeDeployments: async () => [],
      }),
    ).resolves.toMatchObject({
      results: [
        {
          component: "project-host",
          action: "restart_scheduled",
        },
      ],
    });

    expect(recordProjectHostLocalRollbackInternal).not.toHaveBeenCalled();
    expect(rolloutManagedComponents).toHaveBeenCalledWith({
      components: ["project-host"],
      reason: "host_software_upgrade",
      desired_version: desiredVersion,
    });
    expect(setLastKnownGoodArtifactVersionInternal).toHaveBeenCalledWith({
      host_id: "host-1",
      row,
      artifact: "project-host",
      version: desiredVersion,
    });
  });

  it("rejects a same-version rollout when the project-host pid does not change", async () => {
    const desiredVersion = "ph-v2";
    const row = {
      id: "host-1",
      status: "running",
      version: desiredVersion,
      last_seen: new Date(),
      metadata: {
        owner: "account-1",
        software: {
          project_host: desiredVersion,
        },
      },
    };

    await expect(
      rolloutHostManagedComponentsInternalHelper({
        account_id: "account-1",
        id: "host-1",
        components: ["project-host"],
        reason: "host_software_upgrade",
        loadHostForStartStop: async () => row,
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
          getManagedComponentStatus: async () => [
            projectHostStatus({ desiredVersion, pid: 123 }),
          ],
        }),
        waitForHostHeartbeatAfter: async () => undefined,
        installedProjectHostArtifactVersion: () => desiredVersion,
        recordProjectHostLocalRollbackInternal: async () => ({
          host_id: "host-1",
          rollback_version: "ph-v1",
          source: "host-agent",
        }),
        project_host_local_rollback_error_code: "PROJECT_HOST_LOCAL_ROLLBACK",
        setLastKnownGoodArtifactVersionInternal: async () => undefined,
        runtimeDeploymentsForComponentRollout: () => [],
        requestedByForRuntimeDeployments: () => "account-1",
        setProjectHostRuntimeDeployments: async () => undefined,
        loadEffectiveRuntimeDeployments: async () => [],
        projectHostRolloutSettleTimeoutMs: 5,
        projectHostRolloutPollMs: 0,
      }),
    ).rejects.toThrow(
      "project-host rollout did not replace the running process",
    );
  });

  it("waits for project-host handoff when the old daemon still answers during pending rollout", async () => {
    const desiredVersion = "ph-v2";
    const loadHostForStartStop = jest
      .fn()
      .mockResolvedValueOnce({
        id: "host-1",
        status: "running",
        version: desiredVersion,
        last_seen: "2026-04-25T05:00:00.000Z",
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
        last_seen: "2026-04-25T05:00:05.000Z",
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
        last_seen: "2026-04-25T05:00:10.000Z",
        metadata: {
          owner: "account-1",
          software: {
            project_host: desiredVersion,
          },
        },
      });
    const hostControlClient = jest
      .fn()
      .mockResolvedValueOnce({
        getRuntimeLog: async ({ source }) => ({
          source: source ?? "project-host",
          lines: 25,
          text: "",
        }),
        getManagedComponentStatus: async () => [
          projectHostStatus({ desiredVersion, pid: 100 }),
        ],
        rolloutManagedComponents: async () => ({
          results: [
            {
              component: "project-host",
              action: "restart_scheduled",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        getManagedComponentStatus: async () => [
          {
            component: "project-host",
            artifact: "project-host",
            upgrade_policy: "restart_now",
            enabled: true,
            managed: true,
            desired_version: desiredVersion,
            runtime_state: "running",
            version_state: "drifted",
            running_versions: ["ph-v1"],
            running_pids: [123],
          },
        ],
        getHostAgentStatus: async () => ({
          project_host: {
            last_known_good_version: "ph-v1",
            pending_rollout: {
              target_version: desiredVersion,
              previous_version: "ph-v1",
              started_at: "2026-04-25T05:00:05.000Z",
              deadline_at: "2026-04-25T05:02:05.000Z",
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        getManagedComponentStatus: async () => [
          {
            component: "project-host",
            artifact: "project-host",
            upgrade_policy: "restart_now",
            enabled: true,
            managed: true,
            desired_version: desiredVersion,
            runtime_state: "running",
            version_state: "aligned",
            running_versions: [desiredVersion],
            running_pids: [456],
          },
        ],
        getHostAgentStatus: async () => ({
          project_host: {
            last_known_good_version: desiredVersion,
          },
        }),
      })
      .mockResolvedValue({
        getManagedComponentStatus: async () => [
          {
            component: "project-host",
            artifact: "project-host",
            upgrade_policy: "restart_now",
            enabled: true,
            managed: true,
            desired_version: desiredVersion,
            runtime_state: "running",
            version_state: "aligned",
            running_versions: [desiredVersion],
            running_pids: [456],
          },
          {
            component: "conat-router",
            artifact: "project-host",
            upgrade_policy: "restart_now",
            enabled: true,
            managed: true,
            desired_version: desiredVersion,
            runtime_state: "running",
            version_state: "aligned",
            running_versions: [desiredVersion],
            running_pids: [457],
          },
          {
            component: "conat-persist",
            artifact: "project-host",
            upgrade_policy: "restart_now",
            enabled: true,
            managed: true,
            desired_version: desiredVersion,
            runtime_state: "running",
            version_state: "aligned",
            running_versions: [desiredVersion],
            running_pids: [458],
          },
        ],
      });
    const setLastKnownGoodArtifactVersionInternal = jest.fn(
      async () => undefined,
    );
    const recordProjectHostLocalRollbackInternal = jest.fn(async () => ({
      host_id: "host-1",
      rollback_version: "ph-v1",
      source: "host-agent" as const,
    }));

    await expect(
      rolloutHostManagedComponentsInternalHelper({
        account_id: "account-1",
        id: "host-1",
        components: ["project-host"],
        base_url: "https://hub.example.test/software",
        reason: "host_software_upgrade",
        loadHostForStartStop,
        assertHostRunningForUpgrade: () => undefined,
        hostControlClient,
        waitForHostHeartbeatAfter: async () => undefined,
        installedProjectHostArtifactVersion: (row) =>
          `${row?.metadata?.software?.project_host ?? row?.version ?? ""}`.trim() ||
          undefined,
        recordProjectHostLocalRollbackInternal,
        project_host_local_rollback_error_code: "PROJECT_HOST_LOCAL_ROLLBACK",
        setLastKnownGoodArtifactVersionInternal,
        runtimeDeploymentsForComponentRollout: () => [],
        requestedByForRuntimeDeployments: () => "account-1",
        setProjectHostRuntimeDeployments: async () => undefined,
        loadEffectiveRuntimeDeployments: async () => [],
        projectHostRolloutSettleTimeoutMs: 50,
        projectHostRolloutPollMs: 0,
      }),
    ).resolves.toEqual({
      results: [
        {
          component: "project-host",
          action: "restart_scheduled",
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

  it("emits structured project-host activation progress while waiting for candidate promotion", async () => {
    const desiredVersion = "ph-v2";
    const onProgress = jest.fn();
    const loadHostForStartStop = jest
      .fn()
      .mockResolvedValueOnce({
        id: "host-1",
        status: "running",
        version: desiredVersion,
        last_seen: "2026-04-25T05:00:00.000Z",
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
        last_seen: "2026-04-25T05:00:05.000Z",
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
        last_seen: "2026-04-25T05:00:10.000Z",
        metadata: {
          owner: "account-1",
          software: {
            project_host: desiredVersion,
          },
        },
      });
    const hostControlClient = jest
      .fn()
      .mockResolvedValueOnce({
        getRuntimeLog: async ({ source }) => ({
          source: source ?? "project-host",
          lines: 25,
          text: "",
        }),
        getManagedComponentStatus: async () => [
          projectHostStatus({ desiredVersion, pid: 100 }),
        ],
        rolloutManagedComponents: async () => ({
          results: [
            {
              component: "project-host",
              action: "restart_scheduled",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        getManagedComponentStatus: async () => [
          {
            component: "project-host",
            artifact: "project-host",
            upgrade_policy: "restart_now",
            enabled: true,
            managed: true,
            desired_version: desiredVersion,
            runtime_state: "running",
            version_state: "drifted",
            running_versions: ["ph-v1"],
            running_pids: [123],
          },
        ],
        getHostAgentStatus: async () => ({
          project_host: {
            last_known_good_version: "ph-v1",
            pending_rollout: {
              target_version: desiredVersion,
              previous_version: "ph-v1",
              started_at: "2026-04-25T05:00:05.000Z",
              deadline_at: "2026-04-25T05:02:05.000Z",
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        getManagedComponentStatus: async () => [
          {
            component: "project-host",
            artifact: "project-host",
            upgrade_policy: "restart_now",
            enabled: true,
            managed: true,
            desired_version: desiredVersion,
            runtime_state: "running",
            version_state: "aligned",
            running_versions: [desiredVersion],
            running_pids: [456],
          },
        ],
        getHostAgentStatus: async () => ({
          project_host: {
            last_known_good_version: desiredVersion,
          },
        }),
      })
      .mockResolvedValue({
        getManagedComponentStatus: async () => [
          {
            component: "project-host",
            artifact: "project-host",
            upgrade_policy: "restart_now",
            enabled: true,
            managed: true,
            desired_version: desiredVersion,
            runtime_state: "running",
            version_state: "aligned",
            running_versions: [desiredVersion],
            running_pids: [456],
          },
          {
            component: "conat-router",
            artifact: "project-host",
            upgrade_policy: "restart_now",
            enabled: true,
            managed: true,
            desired_version: desiredVersion,
            runtime_state: "running",
            version_state: "aligned",
            running_versions: [desiredVersion],
            running_pids: [457],
          },
          {
            component: "conat-persist",
            artifact: "project-host",
            upgrade_policy: "restart_now",
            enabled: true,
            managed: true,
            desired_version: desiredVersion,
            runtime_state: "running",
            version_state: "aligned",
            running_versions: [desiredVersion],
            running_pids: [458],
          },
        ],
      });

    await expect(
      rolloutHostManagedComponentsInternalHelper({
        account_id: "account-1",
        id: "host-1",
        components: ["project-host"],
        reason: "host_software_upgrade",
        loadHostForStartStop,
        assertHostRunningForUpgrade: () => undefined,
        hostControlClient,
        waitForHostHeartbeatAfter: async () => undefined,
        installedProjectHostArtifactVersion: (row) =>
          `${row?.metadata?.software?.project_host ?? row?.version ?? ""}`.trim() ||
          undefined,
        recordProjectHostLocalRollbackInternal: async () => ({
          host_id: "host-1",
          rollback_version: "ph-v1",
          source: "host-agent" as const,
        }),
        project_host_local_rollback_error_code: "PROJECT_HOST_LOCAL_ROLLBACK",
        setLastKnownGoodArtifactVersionInternal: async () => undefined,
        runtimeDeploymentsForComponentRollout: () => [],
        requestedByForRuntimeDeployments: () => "account-1",
        setProjectHostRuntimeDeployments: async () => undefined,
        loadEffectiveRuntimeDeployments: async () => [],
        projectHostRolloutSettleTimeoutMs: 50,
        projectHostRolloutPollMs: 0,
        onProgress,
      }),
    ).resolves.toEqual({
      results: [
        {
          component: "project-host",
          action: "restart_scheduled",
        },
      ],
    });

    expect(onProgress.mock.calls).toEqual(
      expect.arrayContaining([
        [
          {
            rollout_phase: "project_host.awaiting_heartbeat",
            rollout_phase_label:
              "Waiting for host to return after project-host restart",
            rollout_phase_owner: "project-host activation",
            rollout_target_version: desiredVersion,
          },
        ],
        [
          {
            rollout_phase: "project_host.awaiting_restart",
            rollout_phase_label:
              "Waiting for host-agent to restart project-host",
            rollout_phase_owner: "project-host activation",
            rollout_target_version: desiredVersion,
            rollout_observed_version: "ph-v1",
            rollout_previous_version: "ph-v1",
            rollout_deadline_at: "2026-04-25T05:02:05.000Z",
          },
        ],
        [
          {
            rollout_phase: "project_host.candidate_promoted",
            rollout_phase_label: "Candidate promoted to last known good",
            rollout_phase_owner: "project-host activation",
            rollout_target_version: desiredVersion,
            rollout_observed_version: desiredVersion,
          },
        ],
      ]),
    );
  });

  it("does not fail a project-host rollout on the first stale observation after restart", async () => {
    const desiredVersion = "ph-v2";
    const loadHostForStartStop = jest
      .fn()
      .mockResolvedValueOnce({
        id: "host-1",
        status: "running",
        version: desiredVersion,
        last_seen: "2026-04-25T05:00:00.000Z",
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
        last_seen: "2026-04-25T05:00:05.000Z",
        metadata: {
          owner: "account-1",
          software: {
            project_host: "ph-v1",
          },
        },
      })
      .mockResolvedValueOnce({
        id: "host-1",
        status: "running",
        version: desiredVersion,
        last_seen: "2026-04-25T05:00:10.000Z",
        metadata: {
          owner: "account-1",
          software: {
            project_host: desiredVersion,
          },
          host_agent: {
            project_host: {
              last_known_good_version: desiredVersion,
            },
          },
        },
      });
    const hostControlClient = jest
      .fn()
      .mockResolvedValueOnce({
        getRuntimeLog: async ({ source }) => ({
          source: source ?? "project-host",
          lines: 25,
          text: "",
        }),
        getManagedComponentStatus: async () => [
          projectHostStatus({ desiredVersion, pid: 100 }),
        ],
        rolloutManagedComponents: async () => ({
          results: [
            {
              component: "project-host",
              action: "restart_scheduled",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        getManagedComponentStatus: async () => [
          {
            component: "project-host",
            artifact: "project-host",
            upgrade_policy: "restart_now",
            enabled: true,
            managed: true,
            desired_version: desiredVersion,
            runtime_state: "running",
            version_state: "drifted",
            running_versions: ["ph-v1"],
            running_pids: [123],
          },
        ],
        getHostAgentStatus: async () => ({
          project_host: {
            last_known_good_version: "ph-v1",
          },
        }),
      })
      .mockResolvedValueOnce({
        getManagedComponentStatus: async () => [
          {
            component: "project-host",
            artifact: "project-host",
            upgrade_policy: "restart_now",
            enabled: true,
            managed: true,
            desired_version: desiredVersion,
            runtime_state: "running",
            version_state: "aligned",
            running_versions: [desiredVersion],
            running_pids: [456],
          },
        ],
        getHostAgentStatus: async () => ({
          project_host: {
            last_known_good_version: desiredVersion,
          },
        }),
      })
      .mockResolvedValue({
        getManagedComponentStatus: async () => [
          {
            component: "project-host",
            artifact: "project-host",
            upgrade_policy: "restart_now",
            enabled: true,
            managed: true,
            desired_version: desiredVersion,
            runtime_state: "running",
            version_state: "aligned",
            running_versions: [desiredVersion],
            running_pids: [456],
          },
          {
            component: "conat-router",
            artifact: "project-host",
            upgrade_policy: "restart_now",
            enabled: true,
            managed: true,
            desired_version: desiredVersion,
            runtime_state: "running",
            version_state: "aligned",
            running_versions: [desiredVersion],
            running_pids: [457],
          },
          {
            component: "conat-persist",
            artifact: "project-host",
            upgrade_policy: "restart_now",
            enabled: true,
            managed: true,
            desired_version: desiredVersion,
            runtime_state: "running",
            version_state: "aligned",
            running_versions: [desiredVersion],
            running_pids: [458],
          },
        ],
      });
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
        hostControlClient,
        waitForHostHeartbeatAfter: async () => undefined,
        installedProjectHostArtifactVersion: (row) =>
          `${row?.metadata?.software?.project_host ?? row?.version ?? ""}`.trim() ||
          undefined,
        recordProjectHostLocalRollbackInternal: async () => ({
          host_id: "host-1",
          rollback_version: "ph-v1",
          source: "host-agent",
        }),
        project_host_local_rollback_error_code: "PROJECT_HOST_LOCAL_ROLLBACK",
        setLastKnownGoodArtifactVersionInternal,
        runtimeDeploymentsForComponentRollout: () => [],
        requestedByForRuntimeDeployments: () => "account-1",
        setProjectHostRuntimeDeployments: async () => undefined,
        loadEffectiveRuntimeDeployments: async () => [],
        projectHostRolloutSettleTimeoutMs: 50,
        projectHostRolloutPollMs: 0,
        projectHostRolloutMinObservationMs: 1,
      }),
    ).resolves.toEqual({
      results: [
        {
          component: "project-host",
          action: "restart_scheduled",
        },
      ],
    });

    expect(setLastKnownGoodArtifactVersionInternal).toHaveBeenCalledWith(
      expect.objectContaining({
        host_id: "host-1",
        version: desiredVersion,
      }),
    );
  });

  it("verifies project-host convergence when the managed rollout RPC is disrupted by restart", async () => {
    const desiredVersion = "ph-v2";
    const onProgress = jest.fn();
    const loadHostForStartStop = jest
      .fn()
      .mockResolvedValueOnce({
        id: "host-1",
        status: "running",
        version: desiredVersion,
        last_seen: "2026-04-25T05:00:00.000Z",
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
        last_seen: "2026-04-25T05:00:10.000Z",
        metadata: {
          owner: "account-1",
          software: {
            project_host: desiredVersion,
          },
          host_agent: {
            project_host: {
              last_known_good_version: desiredVersion,
            },
          },
        },
      });
    const hostControlClient = jest
      .fn()
      .mockResolvedValueOnce({
        getRuntimeLog: async ({ source }) => ({
          source: source ?? "project-host",
          lines: 25,
          text: "",
        }),
        getManagedComponentStatus: async () => [
          projectHostStatus({ desiredVersion, pid: 100 }),
        ],
        rolloutManagedComponents: async () => new Promise(() => undefined),
      })
      .mockResolvedValueOnce({
        getManagedComponentStatus: async () => [
          {
            component: "project-host",
            artifact: "project-host",
            upgrade_policy: "restart_now",
            enabled: true,
            managed: true,
            desired_version: desiredVersion,
            runtime_state: "running",
            version_state: "aligned",
            running_versions: [desiredVersion],
            running_pids: [456],
          },
        ],
        getHostAgentStatus: async () => ({
          project_host: {
            last_known_good_version: desiredVersion,
          },
        }),
      })
      .mockResolvedValue({
        getManagedComponentStatus: async () => [
          {
            component: "project-host",
            artifact: "project-host",
            upgrade_policy: "restart_now",
            enabled: true,
            managed: true,
            desired_version: desiredVersion,
            runtime_state: "running",
            version_state: "aligned",
            running_versions: [desiredVersion],
            running_pids: [456],
          },
          {
            component: "conat-router",
            artifact: "project-host",
            upgrade_policy: "restart_now",
            enabled: true,
            managed: true,
            desired_version: desiredVersion,
            runtime_state: "running",
            version_state: "aligned",
            running_versions: [desiredVersion],
            running_pids: [457],
          },
          {
            component: "conat-persist",
            artifact: "project-host",
            upgrade_policy: "restart_now",
            enabled: true,
            managed: true,
            desired_version: desiredVersion,
            runtime_state: "running",
            version_state: "aligned",
            running_versions: [desiredVersion],
            running_pids: [458],
          },
        ],
      });
    const setLastKnownGoodArtifactVersionInternal = jest.fn(
      async () => undefined,
    );

    await expect(
      rolloutHostManagedComponentsInternalHelper({
        account_id: "account-1",
        id: "host-1",
        components: ["project-host", "conat-router", "conat-persist"],
        reason: "host_software_upgrade",
        loadHostForStartStop,
        assertHostRunningForUpgrade: () => undefined,
        hostControlClient,
        waitForHostHeartbeatAfter: async () => undefined,
        installedProjectHostArtifactVersion: (row) =>
          `${row?.metadata?.software?.project_host ?? row?.version ?? ""}`.trim() ||
          undefined,
        recordProjectHostLocalRollbackInternal: async () => ({
          host_id: "host-1",
          rollback_version: "ph-v1",
          source: "host-agent",
        }),
        project_host_local_rollback_error_code: "PROJECT_HOST_LOCAL_ROLLBACK",
        setLastKnownGoodArtifactVersionInternal,
        runtimeDeploymentsForComponentRollout: () => [],
        requestedByForRuntimeDeployments: () => "account-1",
        setProjectHostRuntimeDeployments: async () => undefined,
        loadEffectiveRuntimeDeployments: async () => [],
        managedComponentRolloutRpcTimeoutMs: 1,
        projectHostRolloutSettleTimeoutMs: 5,
        projectHostRolloutPollMs: 0,
        onProgress,
      }),
    ).resolves.toEqual({
      results: [
        {
          component: "project-host",
          action: "restart_scheduled",
          message:
            "project-host rollout RPC timed out; verifying host convergence",
        },
        {
          component: "conat-router",
          action: "restarted",
          message:
            "managed component rollout RPC timed out; verifying host convergence",
        },
        {
          component: "conat-persist",
          action: "restarted",
          message:
            "managed component rollout RPC timed out; verifying host convergence",
        },
      ],
    });

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        rollout_phase: "managed_components.rpc_timeout",
        rollout_phase_label:
          "Managed component rollout request timed out; verifying host state",
      }),
    );
    expect(setLastKnownGoodArtifactVersionInternal).toHaveBeenCalledWith(
      expect.objectContaining({
        host_id: "host-1",
        version: desiredVersion,
      }),
    );
  });

  it("fails timed-out managed rollout when non-project-host services remain drifted", async () => {
    const desiredVersion = "ph-v2";
    const loadHostForStartStop = jest.fn(async () => ({
      id: "host-1",
      status: "running",
      version: desiredVersion,
      last_seen: "2026-04-25T05:00:10.000Z",
      metadata: {
        owner: "account-1",
        software: {
          project_host: desiredVersion,
        },
      },
    }));
    const hostControlClient = jest
      .fn()
      .mockResolvedValueOnce({
        getRuntimeLog: async ({ source }) => ({
          source: source ?? "project-host",
          lines: 25,
          text: "",
        }),
        getManagedComponentStatus: async () => [
          projectHostStatus({ desiredVersion, pid: 100 }),
        ],
        rolloutManagedComponents: async () => new Promise(() => undefined),
      })
      .mockResolvedValue({
        getManagedComponentStatus: async () => [
          {
            component: "project-host",
            artifact: "project-host",
            upgrade_policy: "restart_now",
            enabled: true,
            managed: true,
            desired_version: desiredVersion,
            runtime_state: "running",
            version_state: "aligned",
            running_versions: [desiredVersion],
            running_pids: [456],
          },
          {
            component: "conat-router",
            artifact: "project-host",
            upgrade_policy: "restart_now",
            enabled: true,
            managed: true,
            desired_version: desiredVersion,
            runtime_state: "running",
            version_state: "drifted",
            running_versions: ["ph-v1"],
            running_pids: [457],
          },
          {
            component: "conat-persist",
            artifact: "project-host",
            upgrade_policy: "restart_now",
            enabled: true,
            managed: true,
            desired_version: desiredVersion,
            runtime_state: "running",
            version_state: "drifted",
            running_versions: ["ph-v1"],
            running_pids: [458],
          },
        ],
        getHostAgentStatus: async () => ({
          project_host: {
            last_known_good_version: desiredVersion,
          },
        }),
      });

    await expect(
      rolloutHostManagedComponentsInternalHelper({
        account_id: "account-1",
        id: "host-1",
        components: ["project-host", "conat-router", "conat-persist"],
        reason: "host_software_upgrade",
        loadHostForStartStop,
        assertHostRunningForUpgrade: () => undefined,
        hostControlClient,
        waitForHostHeartbeatAfter: async () => undefined,
        installedProjectHostArtifactVersion: (row) =>
          `${row?.metadata?.software?.project_host ?? row?.version ?? ""}`.trim() ||
          undefined,
        recordProjectHostLocalRollbackInternal: async () => ({
          host_id: "host-1",
          rollback_version: "ph-v1",
          source: "host-agent",
        }),
        project_host_local_rollback_error_code: "PROJECT_HOST_LOCAL_ROLLBACK",
        setLastKnownGoodArtifactVersionInternal: async () => undefined,
        runtimeDeploymentsForComponentRollout: () => [],
        requestedByForRuntimeDeployments: () => "account-1",
        setProjectHostRuntimeDeployments: async () => undefined,
        loadEffectiveRuntimeDeployments: async () => [],
        managedComponentRolloutRpcTimeoutMs: 1,
        projectHostRolloutSettleTimeoutMs: 5,
        projectHostRolloutPollMs: 0,
      }),
    ).rejects.toThrow(/managed component rollout did not converge/);
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
        installedProjectHostArtifactVersion: (row) =>
          row?.metadata?.software?.project_host,
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
        loadEffectiveRuntimeDeployments: async () => [],
        projectHostRolloutSettleTimeoutMs: 5,
        projectHostRolloutPollMs: 0,
      }),
    ).rejects.toThrow(
      /Recent host diagnostics:[\s\S]*\[supervision-events\][\s\S]*\[conat-router\]/,
    );
  });

  it("accepts interrupted managed rollout RPCs when status verification converges", async () => {
    const response = await rolloutHostManagedComponentsInternalHelper({
      account_id: "account-1",
      id: "host-1",
      components: ["conat-router"],
      reason: "automatic_runtime_deployment_reconcile",
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
          text: "",
        }),
        rolloutManagedComponents: async () => {
          throw new Error("socket has been disconnected");
        },
        getManagedComponentStatus: async () => [
          {
            component: "conat-router",
            artifact: "project-host",
            upgrade_policy: "restart_now",
            enabled: true,
            managed: true,
            desired_version: "ph-v1",
            runtime_state: "running",
            version_state: "aligned",
            running_versions: ["ph-v1"],
            running_pids: [4321],
          },
        ],
      }),
      waitForHostHeartbeatAfter: async () => undefined,
      installedProjectHostArtifactVersion: (row) =>
        row?.metadata?.software?.project_host,
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
      loadEffectiveRuntimeDeployments: async () => [],
      projectHostRolloutSettleTimeoutMs: 5,
      projectHostRolloutPollMs: 0,
    });

    expect(response.results).toEqual([
      expect.objectContaining({
        component: "conat-router",
        action: "restarted",
      }),
    ]);
  });

  it("uses heartbeat-observed component status when direct status RPC hangs", async () => {
    const row = {
      id: "host-1",
      status: "running",
      version: "ph-v2",
      last_seen: "2026-04-25T05:00:05.000Z",
      metadata: {
        owner: "account-1",
        software: {
          project_host: "ph-v2",
          project_host_build_id: "build-v2",
        },
        observed_components: [
          projectHostStatus({ desiredVersion: "ph-v2", pid: 123 }),
          {
            component: "conat-router",
            artifact: "project-host",
            upgrade_policy: "restart_now",
            enabled: true,
            managed: true,
            desired_version: "build-v2",
            runtime_state: "running",
            version_state: "aligned",
            running_versions: ["build-v2"],
            running_pids: [456],
          },
        ],
      },
    };
    const getManagedComponentStatus = jest
      .fn()
      .mockResolvedValueOnce([
        projectHostStatus({ desiredVersion: "ph-v2", pid: 100 }),
      ])
      .mockImplementation(() => new Promise(() => undefined));

    const response = await rolloutHostManagedComponentsInternalHelper({
      account_id: "account-1",
      id: "host-1",
      components: ["project-host", "conat-router"],
      reason: "host_software_upgrade",
      loadHostForStartStop: jest.fn(async () => row),
      assertHostRunningForUpgrade: () => undefined,
      hostControlClient: async () => ({
        getRuntimeLog: async ({ source }) => ({
          source: source ?? "project-host",
          lines: 25,
          text: "",
        }),
        rolloutManagedComponents: async () => new Promise(() => undefined),
        getManagedComponentStatus,
        getHostAgentStatus: async () => new Promise(() => undefined),
      }),
      waitForHostHeartbeatAfter: async () => undefined,
      installedProjectHostArtifactVersion: (currentRow) =>
        currentRow?.metadata?.software?.project_host,
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
      loadEffectiveRuntimeDeployments: async () => [],
      managedComponentRolloutRpcTimeoutMs: 1,
      projectHostRolloutSettleTimeoutMs: 20,
      projectHostRolloutPollMs: 0,
      projectHostRolloutMinObservationMs: 0,
    });

    expect(response.results).toEqual([
      expect.objectContaining({
        component: "project-host",
      }),
      expect.objectContaining({
        component: "conat-router",
      }),
    ]);
  });

  it("uses the effective runtime deployment target as the desired project-host version", async () => {
    const runtimeDeploymentsForComponentRollout = jest.fn(() => []);
    const upgradeSoftware = jest.fn(async () => ({
      results: [
        {
          artifact: "project-host" as const,
          version: "ph-v2",
          status: "updated" as const,
        },
      ],
    }));
    const updateProjectHostSoftwareRecord = jest.fn(async () => undefined);
    const recordProjectHostLocalRollbackInternal = jest.fn(async () => ({
      host_id: "host-1",
      rollback_version: "ph-v1",
      source: "host-agent" as const,
    }));
    const setLastKnownGoodArtifactVersionInternal = jest.fn(
      async () => undefined,
    );
    const rolloutManagedComponents = jest.fn(async () => ({
      results: [
        {
          component: "project-host" as const,
          action: "restart_scheduled" as const,
        },
      ],
    }));
    await expect(
      rolloutHostManagedComponentsInternalHelper({
        account_id: "account-1",
        id: "host-1",
        components: ["project-host"],
        base_url: "https://hub.example.test/software",
        reason: "host_software_upgrade",
        loadHostForStartStop: jest
          .fn()
          .mockResolvedValueOnce({
            id: "host-1",
            status: "running",
            version: "ph-v1",
            last_seen: "2026-04-25T05:00:00.000Z",
            metadata: {
              owner: "account-1",
              software: {
                project_host: "ph-v1",
              },
            },
          })
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
                project_host: "ph-v2",
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
          rolloutManagedComponents,
          upgradeSoftware,
          getManagedComponentStatus: async () => [
            projectHostStatus({ desiredVersion: "ph-v2", pid: 123 }),
          ],
        }),
        waitForHostHeartbeatAfter: async () => undefined,
        installedProjectHostArtifactVersion: (row) =>
          row?.metadata?.software?.project_host,
        resolveHostSoftwareBaseUrl: async (baseUrl) => baseUrl,
        resolveReachableUpgradeBaseUrl: async ({ baseUrl }) => baseUrl,
        updateProjectHostSoftwareRecord,
        recordProjectHostLocalRollbackInternal,
        project_host_local_rollback_error_code: "project_host_local_rollback",
        setLastKnownGoodArtifactVersionInternal,
        runtimeDeploymentsForComponentRollout,
        requestedByForRuntimeDeployments: () => "account-1",
        setProjectHostRuntimeDeployments: async () => undefined,
        loadEffectiveRuntimeDeployments: async () => [
          {
            target_type: "artifact",
            target: "project-host",
            desired_version: "ph-v2",
          },
        ],
      }),
    ).resolves.toEqual({
      results: [
        {
          component: "project-host",
          action: "restart_scheduled",
          message:
            "activated project-host candidate; host agent owns the version transition",
        },
      ],
    });

    expect(upgradeSoftware).toHaveBeenCalledWith({
      targets: [{ artifact: "project-host", version: "ph-v2" }],
      base_url: "https://hub.example.test/software",
      restart_project_host: false,
      activate_project_host: true,
      retention_policy: expect.any(Object),
    });
    expect(rolloutManagedComponents).not.toHaveBeenCalled();
    expect(updateProjectHostSoftwareRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        results: [
          {
            artifact: "project-host",
            version: "ph-v2",
            status: "updated",
          },
        ],
      }),
    );
    expect(recordProjectHostLocalRollbackInternal).not.toHaveBeenCalled();
    expect(setLastKnownGoodArtifactVersionInternal).toHaveBeenCalledWith(
      expect.objectContaining({
        host_id: "host-1",
        version: "ph-v2",
      }),
    );
    expect(runtimeDeploymentsForComponentRollout).toHaveBeenCalledWith(
      expect.objectContaining({
        components: ["project-host"],
        desired_version: "ph-v2",
        reason: "host_software_upgrade",
      }),
    );
  });

  it("stages an ACP artifact without activating or recording project-host", async () => {
    const stageProjectHostArtifact = jest.fn(async () => ({
      results: [
        {
          artifact: "project-host" as const,
          version: "ph-v2",
          status: "staged" as const,
        },
      ],
    }));
    const rolloutManagedComponents = jest.fn(async () => ({
      results: [
        {
          component: "acp-worker" as const,
          action: "drain_requested" as const,
        },
      ],
    }));
    const updateProjectHostSoftwareRecord = jest.fn(async () => undefined);
    const runtimeDeploymentsForComponentRollout = jest.fn(() => [
      {
        target_type: "component" as const,
        target: "acp-worker" as const,
        desired_version: "ph-v2",
      },
    ]);
    const setProjectHostRuntimeDeployments = jest.fn(async () => undefined);
    const row = {
      id: "host-1",
      status: "running",
      version: "ph-v1",
      metadata: {
        owner: "account-1",
        software: { project_host: "ph-v1", project_host_build_id: "build-v1" },
      },
    };

    await expect(
      rolloutHostManagedComponentsInternalHelper({
        account_id: "account-1",
        id: "host-1",
        components: ["acp-worker"],
        desired_version: "ph-v2",
        reason: "acp_canary",
        loadHostForStartStop: jest.fn(async () => row),
        assertHostRunningForUpgrade: () => undefined,
        hostControlClient: async () => ({
          getRuntimeLog: async () => ({
            source: "acp-worker",
            lines: 25,
            text: "",
          }),
          stageProjectHostArtifact,
          rolloutManagedComponents,
          getManagedComponentStatus: async () => [
            {
              component: "acp-worker",
              artifact: "project-host",
              upgrade_policy: "drain_then_replace",
              enabled: true,
              managed: true,
              desired_version: "build-v2",
              runtime_state: "running",
              version_state: "aligned",
              running_versions: ["build-v2"],
              running_pids: [5678],
            },
          ],
        }),
        waitForHostHeartbeatAfter: async () => undefined,
        installedProjectHostArtifactVersion: () => "ph-v1",
        resolveHostSoftwareBaseUrl: async () =>
          "https://hub.example.test/software",
        resolveReachableUpgradeBaseUrl: async ({ baseUrl }) => baseUrl,
        updateProjectHostSoftwareRecord,
        recordProjectHostLocalRollbackInternal: async () => ({
          host_id: "host-1",
          rollback_version: "ph-v1",
          source: "host-agent",
        }),
        project_host_local_rollback_error_code: "project_host_local_rollback",
        setLastKnownGoodArtifactVersionInternal: async () => undefined,
        runtimeDeploymentsForComponentRollout,
        requestedByForRuntimeDeployments: () => "account-1",
        setProjectHostRuntimeDeployments,
        loadEffectiveRuntimeDeployments: async () => [
          {
            target_type: "artifact",
            target: "project-host",
            desired_version: "ph-v1",
          },
        ],
        projectHostRolloutSettleTimeoutMs: 10,
        projectHostRolloutPollMs: 0,
        record_runtime_deployments: true,
      }),
    ).resolves.toEqual({
      results: [
        {
          component: "acp-worker",
          action: "drain_requested",
        },
      ],
    });

    expect(stageProjectHostArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        version: "ph-v2",
      }),
    );
    expect(updateProjectHostSoftwareRecord).not.toHaveBeenCalled();
    expect(rolloutManagedComponents).toHaveBeenCalledWith({
      components: ["acp-worker"],
      reason: "acp_canary",
      desired_version: "ph-v2",
    });
    expect(runtimeDeploymentsForComponentRollout).toHaveBeenCalledWith({
      components: ["acp-worker"],
      desired_version: "ph-v2",
      reason: "acp_canary",
    });
    expect(setProjectHostRuntimeDeployments).toHaveBeenCalledWith(
      expect.objectContaining({
        host_id: "host-1",
        deployments: [
          expect.objectContaining({
            target: "acp-worker",
            desired_version: "ph-v2",
          }),
        ],
      }),
    );
  });

  it("appends acp-worker diagnostics when acp worker rollout fails", async () => {
    await expect(
      rolloutHostManagedComponentsInternalHelper({
        account_id: "account-1",
        id: "host-1",
        components: ["acp-worker"],
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
                ? '{"component":"acp-worker","action":"drain_timeout"}'
                : "worker stalled during replacement",
          }),
          rolloutManagedComponents: async () => {
            throw new Error("acp-worker did not report healthy replacement");
          },
        }),
        waitForHostHeartbeatAfter: async () => undefined,
        installedProjectHostArtifactVersion: (row) =>
          row?.metadata?.software?.project_host,
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
        loadEffectiveRuntimeDeployments: async () => [],
        projectHostRolloutSettleTimeoutMs: 5,
        projectHostRolloutPollMs: 0,
      }),
    ).rejects.toThrow(
      /Recent host diagnostics:[\s\S]*\[supervision-events\][\s\S]*\[acp-worker\]/,
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
    const getManagedComponentStatus = jest
      .fn()
      .mockResolvedValueOnce([
        projectHostStatus({ desiredVersion: "ph-v2", pid: 100 }),
      ])
      .mockResolvedValue([
        projectHostStatus({ desiredVersion: "ph-v2", pid: 123 }),
      ]);

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
          getManagedComponentStatus,
        }),
        waitForHostHeartbeatAfter: async () => undefined,
        installedProjectHostArtifactVersion: (row) =>
          row?.metadata?.software?.project_host,
        recordProjectHostLocalRollbackInternal,
        project_host_local_rollback_error_code: "project_host_local_rollback",
        setLastKnownGoodArtifactVersionInternal,
        runtimeDeploymentsForComponentRollout: () => [],
        requestedByForRuntimeDeployments: () => "account-1",
        setProjectHostRuntimeDeployments: async () => undefined,
        loadEffectiveRuntimeDeployments: async () => [],
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
    const getManagedComponentStatus = jest
      .fn()
      .mockResolvedValueOnce([
        projectHostStatus({ desiredVersion: "ph-v2", pid: 100 }),
      ])
      .mockRejectedValue(new Error("project-host still reconnecting"));

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
              observed_components: [
                projectHostStatus({ desiredVersion: "ph-v2", pid: 200 }),
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
          getManagedComponentStatus,
        }),
        waitForHostHeartbeatAfter: async () => undefined,
        installedProjectHostArtifactVersion: (row) =>
          row?.metadata?.software?.project_host,
        recordProjectHostLocalRollbackInternal,
        project_host_local_rollback_error_code: "project_host_local_rollback",
        setLastKnownGoodArtifactVersionInternal,
        runtimeDeploymentsForComponentRollout: () => [],
        requestedByForRuntimeDeployments: () => "account-1",
        setProjectHostRuntimeDeployments: async () => undefined,
        loadEffectiveRuntimeDeployments: async () => [],
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
    const getManagedComponentStatus = jest
      .fn()
      .mockResolvedValueOnce([
        projectHostStatus({ desiredVersion: buildId, pid: 100 }),
      ])
      .mockResolvedValue([
        projectHostStatus({ desiredVersion: buildId, pid: 123 }),
      ]);

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
          getManagedComponentStatus,
        }),
        waitForHostHeartbeatAfter: async () => undefined,
        installedProjectHostArtifactVersion: () => desiredVersion,
        recordProjectHostLocalRollbackInternal,
        project_host_local_rollback_error_code: "project_host_local_rollback",
        setLastKnownGoodArtifactVersionInternal,
        runtimeDeploymentsForComponentRollout: () => [],
        requestedByForRuntimeDeployments: () => "account-1",
        setProjectHostRuntimeDeployments: async () => undefined,
        loadEffectiveRuntimeDeployments: async () => [],
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
