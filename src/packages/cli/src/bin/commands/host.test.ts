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
    project_state?: string;
  }>;
  upgradeRequests?: Array<{
    id: string;
    targets: any[];
    base_url?: string;
    align_runtime_stack?: boolean;
  }>;
  reconciles: string[];
  rollouts: Array<{ id: string; components: string[]; reason?: string }>;
  runtimeDeploymentReconciles: Array<{
    id: string;
    components?: string[];
    reason?: string;
  }>;
  hostProjectStops?: Array<{
    id: string;
    state_filter?: string;
    project_state?: string;
    parallel?: number;
  }>;
  hostProjectRestarts?: Array<{
    id: string;
    state_filter?: string;
    project_state?: string;
    parallel?: number;
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
  lroListRequests?: Array<{
    scope_type: string;
    scope_id: string;
    include_completed?: boolean;
  }>;
  rehomeRequests?: Array<{
    id: string;
    dest_bay_id: string;
    reason?: string;
    campaign_id?: string;
  }>;
  sshTrustRequests?: Array<{
    id: string;
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

function withStderrCapture(fn: () => Promise<void> | void): Promise<string> {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr.write as any) = (
    chunk: any,
    encoding?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ) => {
    lines.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : `${chunk}`);
    const callback = typeof encoding === "function" ? encoding : cb;
    callback?.(null);
    return true;
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      (process.stderr.write as any) = original;
    })
    .then(() => lines.join(""));
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
  capture.hostProjectStops ??= [];
  capture.hostProjectRestarts ??= [];
  capture.lroListRequests ??= [];
  capture.rehomeRequests ??= [];
  capture.sshTrustRequests ??= [];
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
              project_state,
            }) => {
              capture.hostProjectsRequests!.push({
                id,
                limit,
                cursor,
                risk_only,
                state_filter,
                project_state,
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
            upgradeHostSoftware: async ({
              id,
              targets,
              base_url,
              align_runtime_stack,
            }) => {
              capture.upgrades.push(id);
              capture.upgradeRequests!.push({
                id,
                targets,
                base_url,
                align_runtime_stack,
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
            stopHostProjects: async ({
              id,
              state_filter,
              project_state,
              parallel,
            }) => {
              capture.hostProjectStops!.push({
                id,
                state_filter,
                project_state,
                parallel,
              });
              return { op_id: `stop-projects-${id}` };
            },
            restartHostProjects: async ({
              id,
              state_filter,
              project_state,
              parallel,
            }) => {
              capture.hostProjectRestarts!.push({
                id,
                state_filter,
                project_state,
                parallel,
              });
              return { op_id: `restart-projects-${id}` };
            },
            rehomeHost: async ({ id, dest_bay_id, reason, campaign_id }) => {
              capture.rehomeRequests!.push({
                id,
                dest_bay_id,
                reason,
                campaign_id,
              });
              return {
                op_id: `rehome-${id}`,
                host_id: id,
                previous_bay_id: "bay-0",
                owning_bay_id: dest_bay_id,
                operation_stage: "complete",
                operation_status: "succeeded",
                status: "rehomed",
              };
            },
            ensureHostOwnerSshTrust: async ({ id }) => {
              capture.sshTrustRequests!.push({ id });
              return {
                host_id: id,
                bay_id: "bay-0",
                public_key: "ssh-ed25519 AAAATEST cocalc-host-owner",
                host_control_attempted: true,
                host_control_succeeded: false,
                cloud_provider_attempted: true,
                cloud_provider_succeeded: true,
              };
            },
            getHostRehomeOperation: async ({ op_id }) => ({
              op_id,
              host_id: "host-1",
              source_bay_id: "bay-0",
              dest_bay_id: "bay-1",
              status: "succeeded",
              stage: "complete",
              attempt: 1,
            }),
            reconcileHostRehome: async ({ op_id }) => ({
              op_id,
              host_id: "host-1",
              previous_bay_id: "bay-0",
              owning_bay_id: "bay-1",
              operation_stage: "complete",
              operation_status: "succeeded",
              status: "rehomed",
            }),
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
                observed_host_agent: {
                  project_host: {
                    last_known_good_version: "bundle-v1",
                    pending_rollout: {
                      target_version: "bundle-v2",
                      previous_version: "bundle-v1",
                      started_at: "2026-04-16T06:14:11.396Z",
                      deadline_at: "2026-04-16T06:14:31.396Z",
                    },
                    last_automatic_rollback: {
                      target_version: "bundle-v2",
                      rollback_version: "bundle-v1",
                      started_at: "2026-04-16T06:14:11.396Z",
                      finished_at: "2026-04-16T06:14:33.539Z",
                      reason: "health_deadline_exceeded",
                    },
                  },
                },
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
            listHostRuntimeDeployments: async ({ scope_type, id }) => {
              if (scope_type === "global") {
                return [
                  {
                    scope_type: "global",
                    scope_id: "global",
                    target_type: "artifact",
                    target: "project-host",
                    desired_version: "bundle-v2",
                    requested_by: "acct-1",
                    requested_at: "2026-04-15T00:00:00.000Z",
                    updated_at: "2026-04-15T00:00:00.000Z",
                  },
                ];
              }
              return [
                {
                  scope_type: "host",
                  scope_id: id,
                  host_id: id,
                  target_type: "artifact",
                  target: "project-host",
                  desired_version: "bundle-v1",
                  rollout_reason: "automatic_project_host_local_rollback",
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
              ];
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
            list: async ({ scope_type, scope_id, include_completed }) => {
              capture.lroListRequests!.push({
                scope_type,
                scope_id,
                include_completed,
              });
              return [
                {
                  op_id: "op-upgrade-1",
                  kind: "host-upgrade-software",
                  status: "succeeded",
                  input: {
                    targets: [{ artifact: "project-host", channel: "latest" }],
                  },
                  error: null,
                  created_at: "2026-04-18T00:00:00.000Z",
                  started_at: "2026-04-18T00:00:01.000Z",
                  finished_at: "2026-04-18T00:00:10.000Z",
                },
                {
                  op_id: "op-rollback-1",
                  kind: "host-rollback-runtime-deployments",
                  status: "failed",
                  input: {
                    target_type: "component",
                    target: "acp-worker",
                    version: "bundle-v0",
                    reason: "test rollback",
                  },
                  error: "boom",
                  created_at: "2026-04-18T01:00:00.000Z",
                  started_at: "2026-04-18T01:00:01.000Z",
                  finished_at: "2026-04-18T01:00:05.000Z",
                },
                {
                  op_id: "op-host-stop-1",
                  kind: "host-stop",
                  status: "succeeded",
                  input: {},
                  error: null,
                  created_at: "2026-04-18T02:00:00.000Z",
                  started_at: null,
                  finished_at: null,
                },
              ];
            },
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
      if (`${op_id}`.startsWith("stop-projects-")) {
        return {
          op_id,
          status: "succeeded",
          timedOut: false,
          error: undefined,
          result: {
            host_id: `${op_id}`.replace(/^stop-projects-/, ""),
            action: "stop",
            total: 2,
            succeeded: 2,
            failed: 0,
            skipped: 0,
          },
        };
      }
      if (`${op_id}`.startsWith("restart-projects-")) {
        return {
          op_id,
          status: "succeeded",
          timedOut: false,
          error: undefined,
          result: {
            host_id: `${op_id}`.replace(/^restart-projects-/, ""),
            action: "restart",
            total: 2,
            succeeded: 2,
            failed: 0,
            skipped: 0,
          },
        };
      }
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
      align_runtime_stack: false,
    },
  ]);
  assert.equal(capture.data.host_id, "host-1");
  assert.equal(capture.data.status, "queued");
});

test("host upgrade can explicitly align the managed runtime stack", async () => {
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
    "--align-runtime-stack",
  ]);

  assert.deepEqual(capture.upgradeRequests, [
    {
      id: "host-1",
      targets: [{ artifact: "project-host", channel: "latest" }],
      base_url: undefined,
      align_runtime_stack: true,
    },
  ]);
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

test("host ssh-trust forwards the resolved host", async () => {
  const capture: Capture = {
    upgrades: [],
    reconciles: [],
    rollouts: [],
    runtimeDeploymentReconciles: [],
    runtimeDeploymentStatusRequests: [],
    runtimeDeploymentSetRequests: [],
  };
  const deps = makeDeps(capture);
  const program = new Command();
  registerHostCommand(program, deps);

  await program.parseAsync(["node", "test", "host", "ssh-trust", "host-1"]);

  assert.deepEqual(capture.sshTrustRequests, [{ id: "host-1" }]);
  assert.equal(capture.data.host_id, "host-1");
  assert.equal(capture.data.bay_id, "bay-0");
  assert.equal(capture.data.cloud_provider_succeeded, true);
});

test("host rehome refuses to run without --yes", async () => {
  const capture: Capture = {
    upgrades: [],
    reconciles: [],
    rollouts: [],
    runtimeDeploymentReconciles: [],
    runtimeDeploymentStatusRequests: [],
    runtimeDeploymentSetRequests: [],
  };
  const deps = makeDeps(capture);
  const program = new Command();
  registerHostCommand(program, deps);

  await assert.rejects(
    program.parseAsync([
      "node",
      "test",
      "host",
      "rehome",
      "host-1",
      "--bay",
      "bay-1",
    ]),
    /without --yes/,
  );
  assert.deepEqual(capture.rehomeRequests, []);
});

test("host rehome forwards destination bay and metadata", async () => {
  const capture: Capture = {
    upgrades: [],
    reconciles: [],
    rollouts: [],
    runtimeDeploymentReconciles: [],
    runtimeDeploymentStatusRequests: [],
    runtimeDeploymentSetRequests: [],
  };
  const deps = makeDeps(capture);
  const program = new Command();
  registerHostCommand(program, deps);

  await program.parseAsync([
    "node",
    "test",
    "host",
    "rehome",
    "host-1",
    "--bay",
    "bay-1",
    "--reason",
    "drain old bay",
    "--campaign",
    "maint-2026-04",
    "--yes",
  ]);

  assert.deepEqual(capture.rehomeRequests, [
    {
      id: "host-1",
      dest_bay_id: "bay-1",
      reason: "drain old bay",
      campaign_id: "maint-2026-04",
    },
  ]);
  assert.equal(capture.data.host_id, "host-1");
  assert.equal(capture.data.owning_bay_id, "bay-1");
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
      project_state: undefined,
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
      project_state: undefined,
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
      project_state: undefined,
    },
    {
      id: "host-1",
      limit: 50,
      cursor: undefined,
      risk_only: false,
      state_filter: "unprovisioned",
      project_state: undefined,
    },
  ]);
});

test("host projects supports exact raw status filtering", async () => {
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
    "--status",
    "opened",
  ]);

  assert.deepEqual(capture.hostProjectsRequests, [
    {
      id: "host-1",
      limit: 50,
      cursor: undefined,
      risk_only: false,
      state_filter: "all",
      project_state: "opened",
    },
  ]);
  assert.equal(capture.data.state_filter, "all");
  assert.equal(capture.data.project_state, "opened");
});

test("host projects-stop queues a host-scoped stop action", async () => {
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
    "projects-stop",
    "host-1",
    "--status",
    "opened",
    "--parallel",
    "2",
    "--wait",
  ]);

  assert.deepEqual(capture.hostProjectStops, [
    {
      id: "host-1",
      state_filter: "all",
      project_state: "opened",
      parallel: 2,
    },
  ]);
  assert.equal(capture.data.host_id, "host-1");
  assert.equal(capture.data.action, "stop");
  assert.equal(capture.data.status, "succeeded");
  assert.equal(capture.data.total, 2);
});

test("host projects-restart queues a host-scoped restart action", async () => {
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
    "projects-restart",
    "host-1",
    "--state",
    "running",
  ]);

  assert.deepEqual(capture.hostProjectRestarts, [
    {
      id: "host-1",
      state_filter: "running",
      project_state: undefined,
      parallel: undefined,
    },
  ]);
  assert.equal(capture.data.host_id, "host-1");
  assert.equal(capture.data.action, "restart");
  assert.equal(capture.data.status, "queued");
});

test("host projects-stop rejects non-actionable coarse state filters", async () => {
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

  await assert.rejects(
    program.parseAsync([
      "node",
      "test",
      "host",
      "projects-stop",
      "host-1",
      "--state",
      "stopped",
    ]),
    /expected running or all/,
  );
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

test("host deploy restart reuses managed component rollout without changing desired state", async () => {
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
    "restart",
    "host-1",
    "--component",
    "conat-persist",
    "--wait",
  ]);

  assert.deepEqual(capture.rollouts, [
    {
      id: "host-1",
      components: ["conat-persist"],
      reason: undefined,
    },
  ]);
  assert.equal(capture.data.host_id, "host-1");
  assert.equal(capture.data.op_id, "rollout-host-1");
  assert.equal(capture.data.status, "succeeded");
  assert.deepEqual(capture.data.components, ["conat-persist"]);
  assert.deepEqual(capture.runtimeDeploymentSetRequests, []);
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
  assert.equal(
    capture.data.observed_host_agent.project_host.last_known_good_version,
    "bundle-v1",
  );
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
  assert.match(output, /host_agent_last_known_good_version/);
  assert.match(output, /host_agent_last_automatic_rollback_reason/);
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
  assert.equal(capture.data.observed_host_agent, undefined);
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

test("host deploy history lists host-scoped runtime deployment operations", async () => {
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
    "history",
    "host-1",
    "--limit",
    "10",
  ]);

  assert.deepEqual(capture.lroListRequests, [
    { scope_type: "host", scope_id: "host-1", include_completed: true },
  ]);
  assert.equal(capture.data.host_id, "host-1");
  assert.equal(capture.data.rows.length, 2);
  assert.equal(capture.data.rows[0].kind, "upgrade");
  assert.equal(capture.data.rows[0].requested, "project-host@latest");
  assert.equal(capture.data.rows[1].kind, "rollback");
  assert.equal(capture.data.rows[1].requested, "component:acp-worker");
  assert.equal(capture.data.rows[1].version, "bundle-v0");
});

test("host deploy rollback --wait emits deduplicated progress lines in human output", async () => {
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
    makeDeps(
      capture,
      {
        waitForLro: async (_ctx, op_id, opts) => {
          await opts?.onUpdate?.({
            op_id,
            status: "running",
            progress_summary: {
              phase: "waiting",
              target_type: "component",
              target: "acp-worker",
            },
            error: null,
          });
          await opts?.onUpdate?.({
            op_id,
            status: "running",
            progress_summary: {
              phase: "waiting",
              target_type: "component",
              target: "acp-worker",
            },
            error: null,
          });
          await opts?.onUpdate?.({
            op_id,
            status: "succeeded",
            progress_summary: {
              phase: "done",
              target_type: "component",
              target: "acp-worker",
              rollback_version: "bundle-v0",
            },
            error: null,
          });
          return {
            op_id,
            status: "succeeded",
            timedOut: false,
            error: undefined,
          };
        },
      },
      { json: false, output: "table" },
    ),
  );

  const stderr = await withStderrCapture(async () => {
    await program.parseAsync([
      "node",
      "test",
      "host",
      "deploy",
      "rollback",
      "host-1",
      "--component",
      "acp-worker",
      "--wait",
    ]);
  });

  assert.match(
    stderr,
    /host host-host-1 op=deploy-rollback-host-1 status=running phase=waiting target=component:acp-worker/,
  );
  assert.match(
    stderr,
    /host host-host-1 op=deploy-rollback-host-1 status=succeeded phase=done target=component:acp-worker rollback=bundle-v0/,
  );
  assert.equal((stderr.match(/status=running/g) ?? []).length, 1);
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

test("host deploy resume-default removes one host-scoped override", async () => {
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
    "resume-default",
    "host-1",
    "--artifact",
    "project-host",
  ]);

  assert.deepEqual(capture.runtimeDeploymentSetRequests, [
    {
      scope_type: "host",
      id: "host-1",
      replace: true,
      deployments: [
        {
          target_type: "component",
          target: "acp-worker",
          desired_version: "bundle-v1",
          rollout_policy: "drain_then_replace",
          drain_deadline_seconds: undefined,
          rollout_reason: undefined,
          metadata: undefined,
        },
      ],
    },
  ]);
  assert.equal(capture.data.removed, true);
  assert.equal(capture.data.target, "project-host");
});

test("host deploy resume-default removes a project-host component pin when resuming the artifact default", async () => {
  const capture: Capture = {
    upgrades: [],
    reconciles: [],
    rollouts: [],
    runtimeDeploymentReconciles: [],
    runtimeDeploymentStatusRequests: [],
    runtimeDeploymentSetRequests: [],
  };
  const deps = makeDeps(capture);
  const originalWithContext = deps.withContext;
  deps.withContext = async (command, label, fn) =>
    await originalWithContext(command, label, async (ctx) => {
      const originalList = ctx.hub.hosts.listHostRuntimeDeployments;
      ctx.hub.hosts.listHostRuntimeDeployments = async (opts) => {
        if (opts.scope_type === "host") {
          return [
            {
              scope_type: "host",
              scope_id: opts.id,
              host_id: opts.id,
              target_type: "component",
              target: "project-host",
              desired_version: "bundle-v1",
              rollout_reason: "automatic_project_host_local_rollback",
              requested_by: "acct-1",
              requested_at: "2026-04-15T00:00:00.000Z",
              updated_at: "2026-04-15T00:00:00.000Z",
            },
            {
              scope_type: "host",
              scope_id: opts.id,
              host_id: opts.id,
              target_type: "component",
              target: "acp-worker",
              desired_version: "bundle-v1",
              requested_by: "acct-1",
              requested_at: "2026-04-15T00:00:00.000Z",
              updated_at: "2026-04-15T00:00:00.000Z",
            },
          ];
        }
        return await originalList(opts);
      };
      return await fn(ctx);
    });

  const program = new Command();
  registerHostCommand(program, deps);

  await program.parseAsync([
    "node",
    "test",
    "host",
    "deploy",
    "resume-default",
    "host-1",
    "--artifact",
    "project-host",
  ]);

  assert.deepEqual(capture.runtimeDeploymentSetRequests, [
    {
      scope_type: "host",
      id: "host-1",
      replace: true,
      deployments: [
        {
          target_type: "component",
          target: "acp-worker",
          desired_version: "bundle-v1",
          rollout_policy: undefined,
          drain_deadline_seconds: undefined,
          rollout_reason: undefined,
          metadata: undefined,
        },
      ],
    },
  ]);
  assert.equal(capture.data.removed, true);
  assert.equal(capture.data.target, "project-host");
});
