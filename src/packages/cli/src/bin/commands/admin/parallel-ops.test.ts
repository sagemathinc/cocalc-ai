import assert from "node:assert/strict";
import test from "node:test";

import { Command } from "commander";

import { registerParallelOpsCommand } from "./parallel-ops";

const HOST_A = "11111111-1111-4111-8111-111111111111";
const HOST_B = "22222222-2222-4222-8222-222222222222";
const HOST_OFF = "33333333-3333-4333-8333-333333333333";

const WORKERS = [
  {
    worker_kind: "project-host-backup-execution",
    scope_model: "per-project-host",
    dynamic_limit_supported: true,
    default_limit: 4,
    configured_limit: null,
    effective_limit: 4,
    config_source: "constant",
    running_count: 3,
    queued_count: 1,
  },
  {
    worker_kind: "project-move",
    scope_model: "global",
    dynamic_limit_supported: true,
    default_limit: 8,
    configured_limit: null,
    effective_limit: 8,
    config_source: "constant",
    running_count: 0,
    queued_count: 0,
  },
  {
    worker_kind: "cloud-work",
    scope_model: "per-provider",
    dynamic_limit_supported: true,
    default_limit: 5,
    configured_limit: null,
    effective_limit: 5,
    config_source: "constant",
    running_count: 0,
    queued_count: 0,
  },
  {
    worker_kind: "fixed-worker",
    scope_model: "global",
    dynamic_limit_supported: false,
    default_limit: 2,
    configured_limit: null,
    effective_limit: 2,
    config_source: "constant",
    running_count: 0,
    queued_count: 0,
  },
];

// A fake hub: per-host overrides in a map, and calls recorded.
function setup({
  failOn,
  freshAuthMissing,
}: { failOn?: string; freshAuthMissing?: boolean } = {}) {
  const calls: Array<{ name: string; args: any }> = [];
  const overrides = new Map<string, number>([[HOST_B, 2]]);
  let globalOverride: number | null = null;
  const hosts = [
    { id: HOST_A, name: "host-a", status: "running" },
    { id: HOST_B, name: "host-b", status: "running" },
    { id: HOST_OFF, name: "host-off", status: "off" },
  ];
  const hub = {
    system: {
      getParallelOpsStatus: async () =>
        WORKERS.map((w) =>
          w.worker_kind === "project-move" && globalOverride != null
            ? {
                ...w,
                configured_limit: globalOverride,
                effective_limit: globalOverride,
                config_source: "db-override",
              }
            : w,
        ),
      getProjectHostParallelOpsLimit: async ({ host_id, worker_kind }: any) => {
        const configured = overrides.get(host_id) ?? null;
        return {
          worker_kind,
          scope_type: "project_host",
          scope_id: host_id,
          default_limit: 4,
          configured_limit: configured,
          effective_limit: configured ?? 4,
          config_source: configured == null ? "constant" : "db-override",
        };
      },
      setParallelOpsLimit: async (args: any) => {
        calls.push({ name: "set", args });
        if (freshAuthMissing) throw new Error("fresh authentication required");
        if (failOn != null && args.scope_id === failOn)
          throw new Error("host write failed");
        if (args.scope_type === "project_host") {
          overrides.set(args.scope_id, args.limit_value);
        } else {
          globalOverride = args.limit_value;
        }
        return args;
      },
      clearParallelOpsLimit: async (args: any) => {
        calls.push({ name: "clear", args });
        if (args.scope_type === "project_host") overrides.delete(args.scope_id);
        else globalOverride = null;
      },
    },
    hosts: {
      listHosts: async () => hosts,
    },
  };
  let output: any;
  const program = new Command().exitOverride();
  const admin = program.command("admin");
  registerParallelOpsCommand(admin, {
    withContext: async (_command: unknown, _label: string, fn: any) => {
      output = await fn({ globals: {}, hub });
      return output;
    },
  });
  return {
    calls,
    overrides,
    output: () => output,
    run: (...args: string[]) =>
      program.parseAsync(["admin", "parallel-ops", ...args], { from: "user" }),
  };
}

test.afterEach(() => {
  process.exitCode = 0;
});

test("status lists every worker with its limit and source", async () => {
  const h = setup();
  await h.run("status");
  assert.deepEqual(h.output()[0], {
    worker: "project-host-backup-execution",
    scope: "per-project-host",
    running: 3,
    queued: 1,
    limit: 4,
    default: 4,
    source: "constant",
    settable: true,
  });
  assert.equal(h.output().length, 4);
});

test("get shows each host's effective, default and configured limit", async () => {
  const h = setup();
  await h.run(
    "get",
    "--worker",
    "project-host-backup-execution",
    "--all-hosts",
  );
  assert.deepEqual(
    h.output().map((r: any) => [r.host, r.effective, r.configured, r.source]),
    [
      ["host-a", 4, null, "constant"],
      ["host-b", 2, 2, "db-override"],
    ],
  );
});

test("set --all-hosts --dry-run shows before and after on running hosts only, writing nothing", async () => {
  const h = setup();
  await h.run(
    "set",
    "--worker",
    "project-host-backup-execution",
    "--limit",
    "1",
    "--all-hosts",
    "--dry-run",
  );
  assert.deepEqual(h.calls, []);
  assert.deepEqual(
    h.output().map((r: any) => [r.host, r.before, r.after, r.result]),
    [
      ["host-a", 4, null, "would set to 1"],
      ["host-b", 2, null, "would set to 1"],
    ],
  );
});

test("set --all-hosts writes each running host's override, with the note", async () => {
  const h = setup();
  await h.run(
    "set",
    "--worker",
    "project-host-backup-execution",
    "--limit",
    "1",
    "--all-hosts",
    "--note",
    "one backup per host",
  );
  assert.deepEqual(
    h.calls.map((c) => [
      c.args.scope_type,
      c.args.scope_id,
      c.args.limit_value,
      c.args.note,
    ]),
    [
      ["project_host", HOST_A, 1, "one backup per host"],
      ["project_host", HOST_B, 1, "one backup per host"],
    ],
  );
  assert.deepEqual(
    h.output().map((r: any) => [r.host, r.before, r.after, r.source, r.result]),
    [
      ["host-a", 4, 1, "db-override", "set"],
      ["host-b", 2, 1, "db-override", "set"],
    ],
  );
  assert.equal(h.overrides.has(HOST_OFF), false);
  assert.equal(process.exitCode ?? 0, 0);
});

test("set on named hosts (by name or id); one failing host doesn't stop the rest, and the command fails", async () => {
  const h = setup({ failOn: HOST_A });
  await h.run(
    "set",
    "--worker",
    "project-host-backup-execution",
    "--limit",
    "1",
    "--host",
    "host-a",
    "--host",
    HOST_B,
  );
  assert.deepEqual(
    h.output().map((r: any) => [r.host, r.result]),
    [
      ["host-a", "error: host write failed"],
      ["host-b", "set"],
    ],
  );
  assert.equal(process.exitCode, 1);
});

test("clear removes per-host overrides, back to the default", async () => {
  const h = setup();
  await h.run(
    "clear",
    "--worker",
    "project-host-backup-execution",
    "--host",
    "host-b",
  );
  assert.deepEqual(h.calls, [
    {
      name: "clear",
      args: {
        worker_kind: "project-host-backup-execution",
        scope_type: "project_host",
        scope_id: HOST_B,
      },
    },
  ]);
  assert.deepEqual(
    h.output().map((r: any) => [r.before, r.after, r.result]),
    [[2, 4, "cleared"]],
  );
});

test("a global worker is set globally, and rejects host flags", async () => {
  const h = setup();
  await h.run("set", "--worker", "project-move", "--limit", "3");
  assert.deepEqual(h.calls[0].args, {
    worker_kind: "project-move",
    scope_type: "global",
    limit_value: 3,
  });
  assert.deepEqual(
    h.output().map((r: any) => [r.before, r.after, r.result]),
    [[8, 3, "set"]],
  );
  await assert.rejects(
    setup().run(
      "set",
      "--worker",
      "project-move",
      "--limit",
      "3",
      "--all-hosts",
    ),
    /not a per-host one/,
  );
});

test("refuses unknown and fixed workers, a missing host choice, and a bad limit", async () => {
  await assert.rejects(
    setup().run("set", "--worker", "nope", "--limit", "1"),
    /unknown worker 'nope'; known workers: cloud-work, fixed-worker, project-host-backup-execution, project-move/,
  );
  await assert.rejects(
    setup().run("set", "--worker", "fixed-worker", "--limit", "1"),
    /no settable limit/,
  );
  await assert.rejects(
    setup().run(
      "set",
      "--worker",
      "project-host-backup-execution",
      "--limit",
      "1",
    ),
    /--host <id\|name> \(repeatable\) or --all-hosts/,
  );
  await assert.rejects(
    setup().run(
      "set",
      "--worker",
      "project-host-backup-execution",
      "--limit",
      "1",
      "--host",
      "host-a",
      "--all-hosts",
    ),
    /not both/,
  );
  await assert.rejects(
    setup().run(
      "set",
      "--worker",
      "project-host-backup-execution",
      "--limit",
      "0",
      "--all-hosts",
    ),
    /--limit must be a positive integer/,
  );
});

test("a host name that doesn't resolve is reported, and the other hosts still run", async () => {
  const h = setup();
  await h.run(
    "set",
    "--worker",
    "project-host-backup-execution",
    "--limit",
    "1",
    "--host",
    "no-such-host",
    "--host",
    "host-b",
  );
  assert.deepEqual(
    h.output().map((r: any) => [r.host, r.result]),
    [
      ["no-such-host", "error: host 'no-such-host' not found"],
      ["host-b", "set"],
    ],
  );
  assert.deepEqual(
    h.calls.map((c) => c.args.scope_id),
    [HOST_B],
  );
  assert.equal(process.exitCode, 1);
});

test("dry-run clear predicts nothing it can't know", async () => {
  const h = setup();
  await h.run(
    "clear",
    "--worker",
    "project-host-backup-execution",
    "--host",
    "host-b",
    "--dry-run",
  );
  assert.deepEqual(h.calls, []);
  assert.deepEqual(
    h.output().map((r: any) => [r.before, r.after, r.result]),
    [[2, null, "would clear (back to the default)"]],
  );
});

test("a per-provider worker is set globally; there is no --provider", async () => {
  const h = setup();
  await h.run("set", "--worker", "cloud-work", "--limit", "2");
  assert.deepEqual(h.calls[0].args, {
    worker_kind: "cloud-work",
    scope_type: "global",
    limit_value: 2,
  });
  await assert.rejects(
    setup().run(
      "set",
      "--worker",
      "cloud-work",
      "--limit",
      "2",
      "--provider",
      "gcp",
    ),
    /unknown option '--provider'/,
  );
});

test("a host id that isn't in the admin host list is an error, not a stand-in", async () => {
  const h = setup();
  const UNKNOWN = "44444444-4444-4444-8444-444444444444";
  await h.run(
    "set",
    "--worker",
    "project-host-backup-execution",
    "--limit",
    "1",
    "--host",
    UNKNOWN,
  );
  assert.deepEqual(h.calls, []);
  assert.deepEqual(
    h.output().map((r: any) => [r.host, r.result]),
    [[UNKNOWN, `error: host '${UNKNOWN}' not found`]],
  );
  assert.equal(process.exitCode, 1);
});

test("a missing fresh sign-in says to run cocalc auth elevate", async () => {
  const h = setup({ freshAuthMissing: true });
  await h.run(
    "set",
    "--worker",
    "project-host-backup-execution",
    "--limit",
    "1",
    "--host",
    "host-a",
  );
  assert.match(h.output()[0].result, /cocalc auth elevate/);
  assert.equal(process.exitCode, 1);
});
