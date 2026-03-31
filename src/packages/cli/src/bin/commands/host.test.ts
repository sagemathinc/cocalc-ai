import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";

import { registerHostCommand, type HostCommandDeps } from "./host";

function makeDeps(
  capture: { data?: any; upgrades: string[]; reconciles: string[] },
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
    parseOptionalPositiveInteger: (value) => value,
    inferRegionFromZone: () => undefined,
    HOST_CREATE_DISK_TYPES: [],
    HOST_CREATE_STORAGE_MODES: [],
    waitForHostCreateReady: async () => undefined,
    resolveProject: async () => undefined,
    ...overrides,
  };
}

test("host upgrade --all-online targets only online running hosts", async () => {
  const capture: { data?: any; upgrades: string[]; reconciles: string[] } = {
    upgrades: [],
    reconciles: [],
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
  const capture: { data?: any; upgrades: string[]; reconciles: string[] } = {
    upgrades: [],
    reconciles: [],
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
  const capture: { data?: any; upgrades: string[]; reconciles: string[] } = {
    upgrades: [],
    reconciles: [],
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

test("host bootstrap-status returns lifecycle drift data", async () => {
  const capture: { data?: any; upgrades: string[]; reconciles: string[] } = {
    upgrades: [],
    reconciles: [],
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
  const capture: { data?: any; upgrades: string[]; reconciles: string[] } = {
    upgrades: [],
    reconciles: [],
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
  const capture: { data?: any; upgrades: string[]; reconciles: string[] } = {
    upgrades: [],
    reconciles: [],
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
  const capture: { data?: any; upgrades: string[]; reconciles: string[] } = {
    upgrades: [],
    reconciles: [],
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
