import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";

import { registerHostCommand, type HostCommandDeps } from "./host";

type Capture = {
  data?: any;
  upgrades: string[];
  hostProjectsRequests?: Array<{
    id: string;
    limit?: number;
    cursor?: string;
    risk_only?: boolean;
    state_filter?: string;
  }>;
  upgradeRequests?: Array<{
    id: string;
    targets: any[];
    base_url?: string;
  }>;
  reconciles: string[];
  rollouts: Array<{ id: string; components: string[]; reason?: string }>;
  runtimeDeploymentReconciles: Array<{
    id: string;
    components?: string[];
    reason?: string;
  }>;
  runtimeDeploymentRollbacks?: Array<{
    id: string;
    target_type: string;
    target: string;
    version?: string;
    last_known_good?: boolean;
    reason?: string;
  }>;
  runtimeDeploymentStatusRequests: string[];
  runtimeDeploymentSetRequests: Array<{
    scope_type: string;
    id?: string;
    deployments: any[];
    replace?: boolean;
  }>;
};

function withConsoleCapture(fn: () => Promise<void> | void): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: any[]) => {
    lines.push(args.map((x) => `${x ?? ""}`).join(" "));
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console.log = original;
    })
    .then(() => lines.join("\n"));
}

function makeDeps(
  capture: Capture,
  overrides: Partial<HostCommandDeps> = {},
  ctxGlobals: { json?: boolean; output?: "table" | "json" } = {
    json: true,
    output: "json",
  },
): HostCommandDeps {
  capture.runtimeDeploymentRollbacks ??= [];
  capture.upgradeRequests ??= [];
  capture.hostProjectsRequests ??= [];
  return {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        apiBaseUrl: "https://lite2.cocalc.ai",
        timeoutMs: 600_000,
        pollMs: 1,
        globals: ctxGlobals,
        hub: {
          hosts: {
            listHostProjects: async ({
              id,
              limit,
              cursor,
              risk_only,
              state_filter,
            }) => {
              capture.hostProjectsRequests!.push({
                id,
                limit,
                cursor,
                risk_only,
                state_filter,
              });
              return {
                rows: [
                  {
                    project_id: "proj-1",
                    title: "Alpha Project",
                    state: "running",
                    provisioned: true,
                    last_edited: "2026-04-15T01:00:00.000Z",
                    last_backup: "2026-04-15T00:00:00.000Z",
                    needs_backup: true,
                    collab_count: 3,
                  },
                ],
                summary: {
                  total: 1,
                  provisioned: 1,
                  running: 1,
                  provisioned_up_to_date: 0,
                  provisioned_needs_backup: 1,
                },
                next_cursor: "cursor-1",
                host_last_seen: "2026-04-15T02:00:00.000Z",
              };
            },
            upgradeHostSoftware: async ({ id, targets, base_url }) => {
              capture.upgrades.push(id);
              capture.upgradeRequests!.push({
                id,
                targets,
                base_url,
              });
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
            reconcileHostRuntimeDeployments: async ({
              id,
              components,
              reason,
            }) => {
              capture.runtimeDeploymentReconciles.push({
                id,
                components,
                reason,
              });
              return { op_id: `deploy-reconcile-${id}` };
            },
            rollbackHostRuntimeDeployments: async ({
              id,
              target_type,
              target,
              version,
              last_known_good,
              reason,
            }) => {
              capture.runtimeDeploymentRollbacks!.push({
                id,
                target_type,
                target,
                version,
                last_known_good,
                reason,
              });
              return { op_id: `deploy-rollback-${id}` };
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
                    target_type: "artifact",
                    target: "project-host",
                    desired_version: "bundle-v1",
                    requested_by: "acct-1",
                    requested_at: "2026-04-15T00:00:00.000Z",
                    updated_at: "2026-04-15T00:00:00.000Z",
                  },
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
                    target_type: "artifact",
                    target: "project-host",
                    desired_version: "bundle-v1",
                    requested_by: "acct-1",
                    requested_at: "2026-04-15T00:00:00.000Z",
                    updated_at: "2026-04-15T00:00:00.000Z",
                  },
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
                observed_artifacts: [
                  {
                    artifact: "project-host",
                    current_version: "bundle-v1",
                    current_build_id: "build-bundle-v1",
                    installed_versions: ["bundle-v1", "bundle-v0"],
                    referenced_versions: [
                      { version: "bundle-v1", project_count: 2 },
                    ],
                  },
                ],
                observed_targets: [
                  {
                    target_type: "artifact",
                    target: "project-host",
                    desired_version: "bundle-v1",
                    observed_version_state: "aligned",
                    current_version: "bundle-v1",
                    current_build_id: "build-bundle-v1",
                    installed_versions: ["bundle-v1", "bundle-v0"],
                  },
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
                rollback_targets: [
                  {
                    target_type: "artifact",
                    target: "project-host",
                    artifact: "project-host",
                    desired_version: "bundle-v1",
                    current_version: "bundle-v1",
                    previous_version: "bundle-v0",
                    last_known_good_version: "bundle-v0",
                    retained_versions: ["bundle-v1", "bundle-v0"],
                  },
                  {
                    target_type: "component",
                    target: "acp-worker",
                    artifact: "project-host",
                    desired_version: "bundle-v1",
                    current_version: "bundle-v1",
                    previous_version: "bundle-v0",
                    last_known_good_version: "bundle-v0",
                    retained_versions: ["bundle-v1", "bundle-v0"],
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
          lro: {
            get: async ({ op_id }) => ({
              result: `${op_id}`.startsWith("deploy-rollback-")
                ? {
                    host_id: `${op_id}`.replace(/^deploy-rollback-/, ""),
                    target_type: "component",
                    target: "acp-worker",
                    rollback_version: "bundle-v0",
                  }
                : undefined,
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
    waitForLro: async (_ctx, op_id) => {
      if (`${op_id}`.startsWith("deploy-reconcile-")) {
        return {
          op_id,
          status: "succeeded",
          timedOut: false,
          error: undefined,
          result: {
            host_id: `${op_id}`.replace(/^deploy-reconcile-/, ""),
            requested_components: ["acp-worker"],
            reconciled_components: ["acp-worker"],
            decisions: [
              {
                component: "acp-worker",
                decision: "rollout",
                reason: "drifted",
              },
            ],
          },
        };
      }
      return {
        op_id,
        status: "succeeded",
        timedOut: false,
        error: undefined,
      };
    },
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
    runtimeDeploymentReconciles: [],
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

test("host upgrade accepts --artifact-version for explicit version pinning", async () => {
  const capture: Capture = {
    upgrades: [],
    reconciles: [],
    rollouts: [],
    runtimeDeploymentReconciles: [],
    runtimeDeploymentStatusRequests: [],
    runtimeDeploymentSetRequests: [],
  };
  const program = new Command();
  registerHostCommand(program, makeDeps(capture));

  await program.parseAsync([
    "node",
    "test",
    "host",
    "upgrade",
    "host-1",
    "--artifact",
    "project-host",
    "--artifact-version",
    "bundle-v2",
  ]);

  assert.deepEqual(capture.upgradeRequests, [
    {
      id: "host-1",
      targets: [{ artifact: "project-host", version: "bundle-v2" }],
      base_url: undefined,
    },
  ]);
  assert.equal(capture.data.host_id, "host-1");
  assert.equal(capture.data.status, "queued");
});

test("host upgrade --all-online --wait returns all successful hosts", async () => {
  const capture: Capture = {
    upgrades: [],
    reconciles: [],
    rollouts: [],
    runtimeDeploymentReconciles: [],
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
    runtimeDeploymentReconciles: [],
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
    runtimeDeploymentReconciles: [],
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
    runtimeDeploymentReconciles: [],
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

test("host projects lists assigned projects", async () => {
  const capture: Capture = {
    upgrades: [],
    reconciles: [],
    rollouts: [],
    runtimeDeploymentReconciles: [],
    runtimeDeploymentStatusRequests: [],
    runtimeDeploymentSetRequests: [],
  };
  const program = new Command();
  registerHostCommand(program, makeDeps(capture));

  await program.parseAsync([
    "node",
    "test",
    "host",
    "projects",
    "host-1",
    "--limit",
    "25",
    "--cursor",
    "cursor-0",
    "--risk-only",
  ]);

  assert.deepEqual(capture.hostProjectsRequests, [
    {
      id: "host-1",
      limit: 25,
      cursor: "cursor-0",
      risk_only: true,
      state_filter: "running",
    },
  ]);
  assert.equal(capture.data.host_id, "host-1");
  assert.equal(capture.data.name, "host-host-1");
  assert.equal(capture.data.rows.length, 1);
  assert.equal(capture.data.rows[0].project_id, "proj-1");
  assert.equal(capture.data.summary.total, 1);
  assert.equal(capture.data.next_cursor, "cursor-1");
});

test("host projects renders human-readable summary and rows", async () => {
  const capture: Capture = {
    upgrades: [],
    reconciles: [],
    rollouts: [],
    runtimeDeploymentReconciles: [],
    runtimeDeploymentStatusRequests: [],
    runtimeDeploymentSetRequests: [],
  };
  const program = new Command();
  registerHostCommand(
    program,
    makeDeps(capture, {}, { json: false, output: "table" }),
  );

  const output = await withConsoleCapture(async () => {
    await program.parseAsync(["node", "test", "host", "projects", "host-1"]);
  });

  assert.deepEqual(capture.hostProjectsRequests, [
    {
      id: "host-1",
      limit: 50,
      cursor: undefined,
      risk_only: false,
      state_filter: "running",
    },
  ]);
  assert.match(output, /Host ID: host-1/);
  assert.match(output, /Summary/);
  assert.match(output, /Projects/);
  assert.match(output, /state_filter/);
  assert.match(output, /running/);
  assert.match(output, /proj-1/);
  assert.match(output, /needs_backup/);
});

test("host projects supports --all and explicit --state", async () => {
  const capture: Capture = {
    upgrades: [],
    reconciles: [],
    rollouts: [],
    runtimeDeploymentReconciles: [],
    runtimeDeploymentStatusRequests: [],
    runtimeDeploymentSetRequests: [],
  };
  const program = new Command();
  registerHostCommand(program, makeDeps(capture));

  await program.parseAsync([
    "node",
    "test",
    "host",
    "projects",
    "host-1",
    "--all",
  ]);

  await program.parseAsync([
    "node",
    "test",
    "host",
    "projects",
    "host-1",
    "--state",
    "deprovisioned",
  ]);

  assert.deepEqual(capture.hostProjectsRequests, [
    {
      id: "host-1",
      limit: 50,
      cursor: undefined,
      risk_only: false,
      state_filter: "all",
    },
    {
      id: "host-1",
      limit: 50,
      cursor: undefined,
      risk_only: false,
      state_filter: "unprovisioned",
    },
  ]);
});

test("host reconcile queues and waits for completion", async () => {
  const capture: Capture = {
    upgrades: [],
    reconciles: [],
    rollouts: [],
    runtimeDeploymentReconciles: [],
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
    runtimeDeploymentReconciles: [],
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
    runtimeDeploymentReconciles: [],
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
    runtimeDeploymentReconciles: [],
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
    runtimeDeploymentReconciles: [],
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
  assert.equal(capture.data.configured.length, 2);
  assert.equal(capture.data.effective.length, 2);
  assert.equal(capture.data.effective[0].target, "project-host");
  assert.equal(capture.data.effective[1].target, "acp-worker");
  assert.equal(capture.data.observed_artifacts.length, 1);
  assert.equal(capture.data.observed_components.length, 1);
  assert.equal(capture.data.observed_targets.length, 2);
  assert.equal(capture.data.rollback_targets.length, 2);
  assert.equal(
    capture.data.observed_targets[0].observed_version_state,
    "aligned",
  );
  assert.equal(capture.data.observed_targets[0].current_version, "bundle-v1");
  assert.equal(capture.data.rollback_targets[0].target, "project-host");
  assert.equal(capture.data.rollback_targets[0].previous_version, "bundle-v0");
});

test("host deploy status renders flattened human-readable sections", async () => {
  const capture: Capture = {
    upgrades: [],
    reconciles: [],
    rollouts: [],
    runtimeDeploymentReconciles: [],
    runtimeDeploymentStatusRequests: [],
    runtimeDeploymentSetRequests: [],
  };
  const program = new Command();
  registerHostCommand(
    program,
    makeDeps(capture, {}, { json: false, output: "table" }),
  );

  const output = await withConsoleCapture(async () => {
    await program.parseAsync([
      "node",
      "test",
      "host",
      "deploy",
      "status",
      "host-1",
    ]);
  });

  assert.deepEqual(capture.runtimeDeploymentStatusRequests, ["host-1"]);
  assert.match(output, /Host ID: host-1/);
  assert.match(output, /Observed Artifacts/);
  assert.match(output, /referenced_versions/);
  assert.match(output, /bundle-v1 x2/);
  assert.match(output, /Component: acp-worker/);
  assert.match(output, /Configured Targets/);
  assert.match(output, /Effective Targets/);
  assert.match(output, /Observed Targets/);
  assert.match(output, /Rollback Targets/);
  assert.match(output, /last_known_good_version/);
  assert.match(output, /artifact_current_version/);
  assert.match(output, /acp-worker/);
  assert.doesNotMatch(output, /"scope_type":"host"/);
});

test("host deploy status filters by component", async () => {
  const capture: Capture = {
    upgrades: [],
    reconciles: [],
    rollouts: [],
    runtimeDeploymentReconciles: [],
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
    "--component",
    "conat-router",
  ]);

  assert.deepEqual(capture.runtimeDeploymentStatusRequests, ["host-1"]);
  assert.equal(capture.data.configured.length, 1);
  assert.equal(capture.data.configured[0].target_type, "artifact");
  assert.equal(capture.data.configured[0].target, "project-host");
  assert.equal(capture.data.effective.length, 1);
  assert.equal(capture.data.effective[0].target_type, "artifact");
  assert.equal(capture.data.effective[0].target, "project-host");
  assert.equal(capture.data.observed_artifacts.length, 1);
  assert.equal(capture.data.observed_artifacts[0].artifact, "project-host");
  assert.equal(capture.data.observed_artifacts[0].current_version, "bundle-v1");
  assert.deepEqual(capture.data.observed_components, []);
  assert.equal(capture.data.observed_targets.length, 1);
  assert.equal(capture.data.rollback_targets.length, 1);
  assert.equal(capture.data.observed_targets[0].target_type, "artifact");
  assert.equal(capture.data.observed_targets[0].target, "project-host");
  assert.equal(capture.data.rollback_targets[0].target_type, "artifact");
  assert.equal(capture.data.rollback_targets[0].target, "project-host");
  assert.equal(
    capture.data.observed_targets[0].observed_version_state,
    "aligned",
  );
});

test("host deploy reconcile queues desired-state component reconcile", async () => {
  const capture: Capture = {
    upgrades: [],
    reconciles: [],
    rollouts: [],
    runtimeDeploymentReconciles: [],
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
    "reconcile",
    "host-1",
    "--component",
    "acp-worker",
    "--reason",
    "apply-desired-state",
    "--wait",
  ]);

  assert.deepEqual(capture.runtimeDeploymentReconciles, [
    {
      id: "host-1",
      components: ["acp-worker"],
      reason: "apply-desired-state",
    },
  ]);
  assert.equal(capture.data.host_id, "host-1");
  assert.equal(capture.data.op_id, "deploy-reconcile-host-1");
  assert.equal(capture.data.status, "succeeded");
  assert.deepEqual(capture.data.requested_components, ["acp-worker"]);
  assert.deepEqual(capture.data.reconciled_components, ["acp-worker"]);
});

test("host deploy rollback queues runtime rollback and waits for completion", async () => {
  const capture: Capture = {
    upgrades: [],
    reconciles: [],
    rollouts: [],
    runtimeDeploymentReconciles: [],
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
    "rollback",
    "host-1",
    "--component",
    "acp-worker",
    "--to-version",
    "bundle-v0",
    "--reason",
    "test rollback",
    "--wait",
  ]);

  assert.deepEqual(capture.runtimeDeploymentRollbacks, [
    {
      id: "host-1",
      target_type: "component",
      target: "acp-worker",
      version: "bundle-v0",
      last_known_good: false,
      reason: "test rollback",
    },
  ]);
  assert.equal(capture.data.host_id, "host-1");
  assert.equal(capture.data.op_id, "deploy-rollback-host-1");
  assert.equal(capture.data.status, "succeeded");
});

test("host deploy set upserts host-scoped desired state", async () => {
  const capture: Capture = {
    upgrades: [],
    reconciles: [],
    rollouts: [],
    runtimeDeploymentReconciles: [],
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
    "--desired-version",
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
