import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";

import { registerHostCommand, type HostCommandDeps } from "./host";

type Capture = {
  data?: any;
  upgrades: string[];
  reconciles: string[];
  rollouts: Array<{ id: string; components: string[]; reason?: string }>;
  runtimeDeploymentStatusRequests: string[];
  runtimeDeploymentSetRequests: Array<{
    scope_type: string;
    id?: string;
    deployments: any[];
    replace?: boolean;
  }>;
};

function makeDeps(
  capture: Capture,
  overrides: Partial<HostCommandDeps> = {},
): HostCommandDeps {
  return {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        apiBaseUrl: "https://lite2.cocalc.ai",
        timeoutMs: 600_000,
        pollMs: 1,
        globals: { json: true, output: "json" },
        hub: {
          hosts: {
            upgradeHostSoftware: async ({ id }) => {
              capture.upgrades.push(id);
              return { op_id: `op-${id}` };
            },
            reconcileHostSoftware: async ({ id }) => {
              capture.reconciles.push(id);
              return { op_id: `reconcile-${id}` };
            },
            rolloutHostManagedComponents: async ({
              id,
              components,
              reason,
            }) => {
              capture.rollouts.push({ id, components, reason });
              return { op_id: `rollout-${id}` };
            },
            getHostRuntimeDeploymentStatus: async ({ id }) => {
              capture.runtimeDeploymentStatusRequests.push(id);
              return {
                host_id: id,
                configured: [
                  {
                    scope_type: "host",
                    scope_id: id,
                    host_id: id,
                    target_type: "component",
                    target: "acp-worker",
                    desired_version: "bundle-v1",
                    rollout_policy: "drain_then_replace",
                    requested_by: "acct-1",
                    requested_at: "2026-04-15T00:00:00.000Z",
                    updated_at: "2026-04-15T00:00:00.000Z",
                  },
                ],
                effective: [
                  {
                    scope_type: "host",
                    scope_id: id,
                    host_id: id,
                    target_type: "component",
                    target: "acp-worker",
                    desired_version: "bundle-v1",
                    rollout_policy: "drain_then_replace",
                    requested_by: "acct-1",
                    requested_at: "2026-04-15T00:00:00.000Z",
                    updated_at: "2026-04-15T00:00:00.000Z",
                  },
                ],
                observed_components: [
                  {
                    component: "acp-worker",
                    artifact: "project-host",
                    upgrade_policy: "drain_then_replace",
                    enabled: true,
                    managed: true,
                    desired_version: "bundle-v1",
                    runtime_state: "running",
                    version_state: "aligned",
                    running_versions: ["bundle-v1"],
                    running_pids: [1234],
                  },
                ],
                observed_targets: [
                  {
                    target_type: "component",
                    target: "acp-worker",
                    desired_version: "bundle-v1",
                    rollout_policy: "drain_then_replace",
                    observed_runtime_state: "running",
                    observed_version_state: "aligned",
                    running_versions: ["bundle-v1"],
                    running_pids: [1234],
                    enabled: true,
                    managed: true,
                  },
                ],
              };
            },
            setHostRuntimeDeployments: async ({
              scope_type,
              id,
              deployments,
              replace,
            }) => {
              capture.runtimeDeploymentSetRequests.push({
                scope_type,
                id,
                deployments,
                replace,
              });
              return deployments.map((deployment) => ({
                scope_type,
                scope_id: scope_type === "global" ? "global" : id,
                host_id: id,
                requested_by: "acct-1",
                requested_at: "2026-04-15T00:00:00.000Z",
                updated_at: "2026-04-15T00:00:00.000Z",
                ...deployment,
              }));
            },
            getHostMetricsHistory: async (opts) => ({
              window_minutes: opts?.window_minutes ?? 60,
              point_count: 0,
              points: [],
              derived: {
                window_minutes: opts?.window_minutes ?? 60,
                disk: { level: "healthy" },
                metadata: {
                  level: "warning",
                  reason: "metadata usage is high",
                },
                alerts: [
                  {
                    kind: "metadata",
                    level: "warning",
                    message: "metadata usage is high",
                  },
                ],
                admission_allowed: true,
                auto_grow_recommended: false,
              },
            }),
          },
        },
      };
      capture.data = await fn(ctx);
    },
    listHosts: async () => [],
    resolveHost: async (_ctx, host) => ({
      id: host,
      name: `host-${host}`,
      status: "running",
      last_seen: new Date().toISOString(),
    }),
    normalizeHostProviderValue: (value) => value,
    summarizeHostCatalogEntries: (value) => value,
    emitProjectFileCatHumanContent: () => undefined,
    parseHostSoftwareArtifactsOption: (value) =>
      value && value.length ? value : ["project-host", "project", "tools"],
    parseHostSoftwareChannelsOption: (value) => value ?? ["latest"],
    waitForLro: async (_ctx, op_id) => ({
      op_id,
      status: "succeeded",
      timedOut: false,
      error: undefined,
    }),
    ensureSyncKeyPair: async () => undefined,
    resolveHostSshEndpoint: async () => undefined,
    expandUserPath: (value) => value,
    parseHostMachineJson: (value) => value,
    parseOptionalPositiveInteger: (value) =>
      value == null ? undefined : Number(value),
    inferRegionFromZone: () => undefined,
    HOST_CREATE_DISK_TYPES: [],
    HOST_CREATE_STORAGE_MODES: [],
    waitForHostCreateReady: async () => undefined,
    resolveProject: async () => undefined,
    ...overrides,
  };
}

test("host upgrade --all-online targets only online running hosts", async () => {
  const capture: Capture = {
    upgrades: [],
    reconciles: [],
    rollouts: [],
    runtimeDeploymentStatusRequests: [],
    runtimeDeploymentSetRequests: [],
  };
  const deps = makeDeps(capture, {
    listHosts: async () => [
      {
        id: "online-1",
        name: "online-1",
        status: "running",
        last_seen: new Date().toISOString(),
      },
      {
        id: "stale-1",
        name: "stale-1",
        status: "running",
        last_seen: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      },
      {
        id: "off-1",
        name: "off-1",
        status: "off",
        last_seen: new Date().toISOString(),
      },
    ],
  });
  const program = new Command();
  registerHostCommand(program, deps);

  await program.parseAsync([
    "node",
    "test",
    "host",
    "upgrade",
    "--all-online",
    "--hub-source",
  ]);

  assert.deepEqual(capture.upgrades, ["online-1"]);
  assert.equal(capture.data.status, "queued");
  assert.equal(capture.data.host_id, "online-1");
});

test("host upgrade --all-online --wait returns all successful hosts", async () => {
  const capture: Capture = {
    upgrades: [],
    reconciles: [],
    rollouts: [],
    runtimeDeploymentStatusRequests: [],
    runtimeDeploymentSetRequests: [],
  };
  const deps = makeDeps(capture, {
    listHosts: async () => [
      {
        id: "online-1",
        name: "online-1",
        status: "running",
        last_seen: new Date().toISOString(),
      },
      {
        id: "online-2",
        name: "online-2",
        status: "active",
        last_seen: new Date().toISOString(),
      },
    ],
  });
  const program = new Command();
  registerHostCommand(program, deps);

  await program.parseAsync([
    "node",
    "test",
    "host",
    "upgrade",
    "--all-online",
    "--wait",
  ]);

  assert.deepEqual(capture.upgrades, ["online-1", "online-2"]);
  assert.equal(capture.data.status, "succeeded");
  assert.equal(capture.data.count, 2);
  assert.equal(capture.data.hosts.length, 2);
});

test("host metrics returns current metrics and history", async () => {
  const capture: Capture = {
    upgrades: [],
    reconciles: [],
    rollouts: [],
    runtimeDeploymentStatusRequests: [],
    runtimeDeploymentSetRequests: [],
  };
  const deps = makeDeps(capture, {
    resolveHost: async () => ({
      id: "host-1",
      name: "host-1",
      status: "running",
      last_seen: new Date().toISOString(),
      metrics: {
        current: {
          cpu_percent: 55,
        },
      },
    }),
  });
  const program = new Command();
  registerHostCommand(program, deps);

  await program.parseAsync([
    "node",
    "test",
    "host",
    "metrics",
    "host-1",
    "--window",
    "24h",
    "--points",
    "120",
  ]);

  assert.equal(capture.data.host_id, "host-1");
  assert.equal(capture.data.current.cpu_percent, 55);
  assert.equal(capture.data.history.window_minutes, 24 * 60);
  assert.equal(capture.data.derived.metadata.level, "warning");
});

test("host where returns the bay for the resolved host", async () => {
  const capture: Capture = {
    upgrades: [],
    reconciles: [],
    rollouts: [],
    runtimeDeploymentStatusRequests: [],
    runtimeDeploymentSetRequests: [],
  };
  const deps = makeDeps(capture, {
    resolveHost: async () => ({
      id: "44444444-4444-4444-4444-444444444444",
      name: "host-1",
      status: "running",
      last_seen: new Date().toISOString(),
    }),
    withContext: async (_command, _label, fn) => {
      const ctx = {
        apiBaseUrl: "https://lite2.cocalc.ai",
        timeoutMs: 600_000,
        pollMs: 1,
        globals: { json: true, output: "json" },
        hub: {
          system: {
            getHostBay: async ({ host_id }) => ({
              host_id,
              bay_id: "bay-0",
              name: "host-1",
              source: "single-bay-default",
            }),
          },
          hosts: {
            upgradeHostSoftware: async ({ id }) => {
              capture.upgrades.push(id);
              return { op_id: `op-${id}` };
            },
            reconcileHostSoftware: async ({ id }) => {
              capture.reconciles.push(id);
              return { op_id: `reconcile-${id}` };
            },
            getHostMetricsHistory: async (opts) => ({
              window_minutes: opts?.window_minutes ?? 60,
              point_count: 0,
              points: [],
              derived: {
                window_minutes: opts?.window_minutes ?? 60,
                disk: { level: "healthy" },
                metadata: {
                  level: "warning",
                  reason: "metadata usage is high",
                },
                alerts: [],
                admission_allowed: true,
                auto_grow_recommended: false,
              },
            }),
          },
        },
      };
      capture.data = await fn(ctx);
    },
  });
  const program = new Command();
  registerHostCommand(program, deps);

  await program.parseAsync(["node", "test", "host", "where", "host-1"]);

  assert.equal(capture.data.host_id, "44444444-4444-4444-4444-444444444444");
  assert.equal(capture.data.bay_id, "bay-0");
});

test("host bootstrap-status returns lifecycle drift data", async () => {
  const capture: Capture = {
    upgrades: [],
    reconciles: [],
    rollouts: [],
    runtimeDeploymentStatusRequests: [],
    runtimeDeploymentSetRequests: [],
  };
  const deps = makeDeps(capture, {
    resolveHost: async () => ({
      id: "host-1",
      name: "host-1",
      status: "running",
      bootstrap: {
        status: "done",
        message: "Host software reconciled",
      },
      bootstrap_lifecycle: {
        summary_status: "drifted",
        summary_message: "2 drift items detected",
        drift_count: 2,
        items: [
          {
            key: "project_bundle",
            label: "Project bundle",
            desired: "20260330T010000Z",
            installed: "20260329T230000Z",
            status: "drift",
          },
        ],
      },
    }),
  });
  const program = new Command();
  registerHostCommand(program, deps);

  await program.parseAsync([
    "node",
    "test",
    "host",
    "bootstrap-status",
    "host-1",
  ]);

  assert.equal(capture.data.host_id, "host-1");
  assert.equal(capture.data.bootstrap_lifecycle.summary_status, "drifted");
  assert.equal(capture.data.bootstrap_lifecycle.drift_count, 2);
});

test("host reconcile queues and waits for completion", async () => {
  const capture: Capture = {
    upgrades: [],
    reconciles: [],
    rollouts: [],
    runtimeDeploymentStatusRequests: [],
    runtimeDeploymentSetRequests: [],
  };
  const program = new Command();
  registerHostCommand(program, makeDeps(capture));

  await program.parseAsync([
    "node",
    "test",
    "host",
    "reconcile",
    "host-1",
    "--wait",
  ]);

  assert.equal(capture.data.host_id, "host-1");
  assert.equal(capture.data.op_id, "reconcile-host-1");
  assert.equal(capture.data.status, "succeeded");
  assert.deepEqual(capture.reconciles, ["host-1"]);
});

test("host reconcile --all-online targets only online running hosts", async () => {
  const capture: Capture = {
    upgrades: [],
    reconciles: [],
    rollouts: [],
    runtimeDeploymentStatusRequests: [],
    runtimeDeploymentSetRequests: [],
  };
  const deps = makeDeps(capture, {
    listHosts: async () => [
      {
        id: "online-1",
        name: "online-1",
        status: "running",
        last_seen: new Date().toISOString(),
      },
      {
        id: "stale-1",
        name: "stale-1",
        status: "running",
        last_seen: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      },
      {
        id: "off-1",
        name: "off-1",
        status: "off",
        last_seen: new Date().toISOString(),
      },
    ],
  });
  const program = new Command();
  registerHostCommand(program, deps);

  await program.parseAsync([
    "node",
    "test",
    "host",
    "reconcile",
    "--all-online",
  ]);

  assert.deepEqual(capture.reconciles, ["online-1"]);
  assert.equal(capture.data.status, "queued");
  assert.equal(capture.data.host_id, "online-1");
  assert.equal(capture.data.op_id, "reconcile-online-1");
});

test("host reconcile --all-online --wait returns all successful hosts", async () => {
  const capture: Capture = {
    upgrades: [],
    reconciles: [],
    rollouts: [],
    runtimeDeploymentStatusRequests: [],
    runtimeDeploymentSetRequests: [],
  };
  const deps = makeDeps(capture, {
    listHosts: async () => [
      {
        id: "online-1",
        name: "online-1",
        status: "running",
        last_seen: new Date().toISOString(),
      },
      {
        id: "online-2",
        name: "online-2",
        status: "active",
        last_seen: new Date().toISOString(),
      },
    ],
  });
  const program = new Command();
  registerHostCommand(program, deps);

  await program.parseAsync([
    "node",
    "test",
    "host",
    "reconcile",
    "--all-online",
    "--wait",
  ]);

  assert.deepEqual(capture.reconciles, ["online-1", "online-2"]);
  assert.equal(capture.data.status, "succeeded");
  assert.equal(capture.data.count, 2);
  assert.equal(capture.data.hosts.length, 2);
});

test("host rollout queues managed component rollout and waits for completion", async () => {
  const capture: Capture = {
    upgrades: [],
    reconciles: [],
    rollouts: [],
    runtimeDeploymentStatusRequests: [],
    runtimeDeploymentSetRequests: [],
  };
  const program = new Command();
  registerHostCommand(program, makeDeps(capture));

  await program.parseAsync([
    "node",
    "test",
    "host",
    "rollout",
    "host-1",
    "--component",
    "acp-worker,project-host",
    "--reason",
    "bundle-upgrade",
    "--wait",
  ]);

  assert.deepEqual(capture.rollouts, [
    {
      id: "host-1",
      components: ["acp-worker", "project-host"],
      reason: "bundle-upgrade",
    },
  ]);
  assert.equal(capture.data.host_id, "host-1");
  assert.equal(capture.data.op_id, "rollout-host-1");
  assert.equal(capture.data.status, "succeeded");
  assert.deepEqual(capture.data.components, ["acp-worker", "project-host"]);
});

test("host deploy status shows configured and effective desired state", async () => {
  const capture: Capture = {
    upgrades: [],
    reconciles: [],
    rollouts: [],
    runtimeDeploymentStatusRequests: [],
    runtimeDeploymentSetRequests: [],
  };
  const program = new Command();
  registerHostCommand(program, makeDeps(capture));

  await program.parseAsync([
    "node",
    "test",
    "host",
    "deploy",
    "status",
    "host-1",
  ]);

  assert.deepEqual(capture.runtimeDeploymentStatusRequests, ["host-1"]);
  assert.equal(capture.data.host_id, "host-1");
  assert.equal(capture.data.name, "host-host-1");
  assert.equal(capture.data.configured.length, 1);
  assert.equal(capture.data.effective.length, 1);
  assert.equal(capture.data.effective[0].target, "acp-worker");
  assert.equal(capture.data.observed_components.length, 1);
  assert.equal(capture.data.observed_targets.length, 1);
  assert.equal(
    capture.data.observed_targets[0].observed_version_state,
    "aligned",
  );
});

test("host deploy set upserts host-scoped desired state", async () => {
  const capture: Capture = {
    upgrades: [],
    reconciles: [],
    rollouts: [],
    runtimeDeploymentStatusRequests: [],
    runtimeDeploymentSetRequests: [],
  };
  const program = new Command();
  registerHostCommand(program, makeDeps(capture));

  await program.parseAsync([
    "node",
    "test",
    "host",
    "deploy",
    "set",
    "--host",
    "host-1",
    "--component",
    "acp-worker",
    "--version",
    "bundle-v2",
    "--policy",
    "drain_then_replace",
    "--drain-deadline-seconds",
    "3600",
    "--reason",
    "canary",
  ]);

  assert.deepEqual(capture.runtimeDeploymentSetRequests, [
    {
      scope_type: "host",
      id: "host-1",
      replace: false,
      deployments: [
        {
          target_type: "component",
          target: "acp-worker",
          desired_version: "bundle-v2",
          rollout_policy: "drain_then_replace",
          drain_deadline_seconds: 3600,
          rollout_reason: "canary",
        },
      ],
    },
  ]);
  assert.equal(capture.data.scope_type, "host");
  assert.equal(capture.data.host_id, "host-1");
  assert.equal(capture.data.deployments[0].desired_version, "bundle-v2");
});
