import assert from "node:assert/strict";
import { it } from "node:test";
import { Command } from "commander";
import {
  GPU_POD_WRITE_RPC_TIMEOUT_MS,
  GPU_READ_TIMEOUT_MS,
} from "@cocalc/util/gpu/runpod";
import { GPU_CLI_RPC_TIMEOUT_MS, registerGpuCommand } from "./gpu";

const CATALOG = {
  provider: "runpod",
  catalog: {
    as_of: "2026-10-27T21:00:00.000Z",
    gpuTypes: [
      {
        id: "NVIDIA RTX A4000",
        name: "RTX A4000",
        memoryGb: 16,
        secure: { price: 0.25, availability: "HIGH", dataCenters: {} },
      },
    ],
    dataCenters: [
      {
        id: "EU-FR-1",
        name: "EU France 1",
        region: "EUROPE",
        compliance: ["GDPR"],
      },
    ],
  },
};
const PODS = {
  provider: "runpod",
  as_of: "2026-10-27T21:00:00.000Z",
  scope: "account",
  pods: [
    {
      id: "pod_abc123",
      name: "cc-7f3k9q2x",
      status: "RUNNING",
      cost: 0.27,
      gpuTypeId: "NVIDIA RTX A5000",
      gpuCount: 1,
    },
  ],
};

const RECORD = {
  id: "00000000-1000-4000-8000-000000000099",
  handle: "cc-7f3k9q2x",
  provider: "runpod",
  provider_pod_id: "pod_abc123",
  state: "running",
  desired_state: "running",
  key_owner_account_id: "00000000-1000-4000-8000-000000000001",
  beneficiary_account_id: "00000000-1000-4000-8000-000000000001",
  project_id: "00000000-1000-4000-8000-0000000000aa",
  gpu_type_id: "NVIDIA RTX A5000",
  gpu_count: 1,
  cloud: "SECURE",
  image: "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404",
  cost_per_hr: "0.27",
  max_runtime_minutes: 60,
  deadline: "2026-10-27T22:00:00.000Z",
  created: "2026-10-27T21:00:00.000Z",
  updated: "2026-10-27T21:00:00.000Z",
};
const EVENT = {
  id: "e1",
  pod_id: RECORD.id,
  at: "2026-10-27T21:00:00.000Z",
  actor_kind: "user",
  action: "create",
};
const MANAGED = { ...PODS, scope: "managed", records: [RECORD] };
const RECORD_ROW = {
  handle: "cc-7f3k9q2x",
  state: "running",
  status: "RUNNING",
  gpu: "NVIDIA RTX A5000",
  count: 1,
  cost_per_hr: "0.27",
  cloud: "SECURE",
  deadline: "2026-10-27T22:00:00.000Z",
  pod_id: "pod_abc123",
  reason: null,
};

const AGENT_REQUEST = {
  request_id: "00000000-1000-4000-8000-0000000000c1",
  project_id: "00000000-1000-4000-8000-0000000000aa",
  principal_kind: "chat_session",
  operation_id: "op-1",
  payload: {
    spec: {
      gpu_type_id: "NVIDIA RTX A5000",
      gpu_count: 1,
      image: "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404",
      max_runtime_minutes: 60,
    },
    hourly_usd: "0.2700000000",
    max_cost_usd: "0.30",
    max_pods: 1,
  },
  payload_hash: "a".repeat(64),
  state: "pending",
  created: "2026-10-28T12:00:00.000Z",
  expires_at: "2026-10-28T12:30:00.000Z",
};

function harness(
  globals: Record<string, unknown> = {},
  { fail = false }: { fail?: boolean } = {},
) {
  const calls: Array<{ name: string; args: unknown }> = [];
  const outputs: unknown[] = [];
  // The CLI's defaults: 600 s overall, 30 s per hub RPC.
  const ctx: any = { globals, timeoutMs: 600_000, rpcTimeoutMs: 30_000 };
  const seen: Array<{ timeoutMs: number; rpcTimeoutMs: number }> = [];
  const observe = () => {
    seen.push({ timeoutMs: ctx.timeoutMs, rpcTimeoutMs: ctx.rpcTimeoutMs });
    if (fail) throw new Error("hub call failed");
  };
  const program = new Command()
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerGpuCommand(program, {
    withContext: async (_cmd, _name, fn) => {
      ctx.hub = {
        gpu: {
          catalog: async (args) => {
            calls.push({ name: "catalog", args });
            observe();
            return CATALOG;
          },
          availability: async (args) => {
            calls.push({ name: "availability", args });
            observe();
            return { provider: "runpod", as_of: "x", offers: [] };
          },
          pods: async (args) => {
            calls.push({ name: "pods", args });
            observe();
            return (args as any)?.scope === "account" ? PODS : MANAGED;
          },
          launch: async (args) => {
            calls.push({ name: "launch", args });
            observe();
            return RECORD;
          },
          terminate: async (args) => {
            calls.push({ name: "terminate", args });
            observe();
            return { state: "terminated" };
          },
          budget: async (args) => {
            calls.push({ name: "budget", args });
            observe();
            return { authorized_usd: "20" };
          },
          setBudget: async (args) => {
            calls.push({ name: "setBudget", args });
            observe();
            return { authorized_usd: "10" };
          },
          killSwitch: async (args) => {
            calls.push({ name: "killSwitch", args });
            observe();
            return { marked: 1, remaining: 0, paused: true };
          },
          resume: async (args) => {
            calls.push({ name: "resume", args });
            observe();
            return { resumed: 1 };
          },
          alerts: async (args) => {
            calls.push({ name: "alerts", args });
            observe();
            return [ALERT];
          },
          acknowledgeAlert: async (args) => {
            calls.push({ name: "acknowledgeAlert", args });
            observe();
            return { ...ALERT, resolved_at: "2026-10-28T21:00:00.000Z" };
          },
          releaseQuarantined: async (args) => {
            calls.push({ name: "releaseQuarantined", args });
            observe();
            return { pod_id: "p1", released_usd: "1.5", warning: "w" };
          },
          accountChecks: async (args) => {
            calls.push({ name: "accountChecks", args });
            observe();
            return { state: "off", confirmed_at: null, last_checked_at: null };
          },
          confirmAccountChecks: async (args) => {
            calls.push({ name: "confirmAccountChecks", args });
            observe();
            return {
              state: "on",
              confirmed_at: "2026-10-28T21:00:00.000Z",
              last_checked_at: null,
            };
          },
          reportCompromised: async (args) => {
            calls.push({ name: "reportCompromised", args });
            observe();
            return {
              closed: false,
              awaiting_provider_revocation: true,
              provider_pods: 0,
              managed_pods: 0,
              warning: "check RunPod's Pods page once",
            };
          },
          who: async (args) => {
            calls.push({ name: "who", args });
            observe();
            return [{ pod: RECORD, events: [EVENT] }];
          },
          agentRequests: async (args) => {
            calls.push({ name: "agentRequests", args });
            observe();
            return [AGENT_REQUEST];
          },
          approveAgentRequest: async (args) => {
            calls.push({ name: "approveAgentRequest", args });
            observe();
            return { grant_id: "g1", state: "active" };
          },
          revokeAgentGrant: async (args) => {
            calls.push({ name: "revokeAgentGrant", args });
            observe();
            return { grant_id: "g1", state: "revoked" };
          },
        },
      };
      outputs.push(await fn(ctx));
    },
  });
  return {
    calls,
    outputs,
    ctx,
    seen,
    run: (...args: string[]) =>
      program.parseAsync(["gpu", ...args], { from: "user" }),
  };
}

it("turns availability flags into the API filter", async () => {
  const h = harness();
  await h.run(
    "availability",
    "--gpu",
    "RTX A4000,H100 SXM",
    "--gpu",
    "RTX 4090",
    "--cloud",
    "community",
    "--region",
    "EUROPE",
    "--data-center",
    "EU-FR-1",
    "--min-stock",
    "medium",
    "--max-price",
    "0.5",
    "--min-count",
    "2",
  );
  assert.deepEqual(h.calls, [
    {
      name: "availability",
      args: {
        gpu: ["RTX A4000", "H100 SXM", "RTX 4090"],
        cloud: "COMMUNITY",
        region: ["EUROPE"],
        data_center: ["EU-FR-1"],
        min_stock: "MEDIUM",
        max_price_per_gpu_hour: 0.5,
        min_count: 2,
      },
    },
  ]);
});

it("rejects a bad number before calling the hub", async () => {
  const h = harness();
  await assert.rejects(h.run("availability", "--max-price", "-1"));
  await assert.rejects(h.run("availability", "--min-count", "1.5"));
  assert.equal(h.calls.length, 0);
});

it("shows summary rows in tables and the full result with --json", async () => {
  const table = harness();
  await table.run("catalog");
  await table.run("catalog", "--data-centers");
  await table.run("pods", "--all");
  assert.deepEqual(table.outputs, [
    [
      {
        id: "NVIDIA RTX A4000",
        name: "RTX A4000",
        memory_gb: 16,
        secure_price: 0.25,
        secure_stock: "HIGH",
        community_price: null,
        community_stock: "not offered",
      },
    ],
    [
      {
        id: "EU-FR-1",
        name: "EU France 1",
        region: "EUROPE",
        compliance: "GDPR",
      },
    ],
    [
      {
        id: "pod_abc123",
        name: "cc-7f3k9q2x",
        status: "RUNNING",
        gpu: "NVIDIA RTX A5000",
        count: 1,
        cost_per_hr: 0.27,
        cloud: null,
        data_center: null,
        created: null,
      },
    ],
  ]);
  const json = harness({ json: true });
  await json.run("catalog");
  await json.run("pods", "--all");
  assert.deepEqual(json.outputs, [CATALOG, PODS]);
});

it("reads one pod by id", async () => {
  const h = harness();
  await h.run("pods", "--all", "--id", "pod_abc123");
  assert.deepEqual(h.calls, [
    { name: "pods", args: { pod_id: "pod_abc123", scope: "account" } },
  ]);
  assert.deepEqual(h.outputs, [PODS.pods[0]]);
});

it("gives every GPU read a bounded budget beyond the server's, then restores the context", async () => {
  assert.ok(GPU_CLI_RPC_TIMEOUT_MS > GPU_READ_TIMEOUT_MS);
  assert.ok(GPU_CLI_RPC_TIMEOUT_MS <= 5 * 60_000);
  const h = harness();
  await h.run("catalog");
  await h.run("availability", "--cloud", "SECURE");
  await h.run("pods");
  assert.deepEqual(
    h.seen,
    Array(3).fill({
      timeoutMs: 600_000,
      rpcTimeoutMs: GPU_CLI_RPC_TIMEOUT_MS,
    }),
  );
  assert.equal(h.ctx.timeoutMs, 600_000);
  assert.equal(h.ctx.rpcTimeoutMs, 30_000);
});

it("restores the context's timeouts when a read fails", async () => {
  const h = harness({}, { fail: true });
  await assert.rejects(h.run("pods"), /hub call failed/);
  assert.equal(h.seen[0].rpcTimeoutMs, GPU_CLI_RPC_TIMEOUT_MS);
  assert.equal(h.ctx.rpcTimeoutMs, 30_000);
  assert.equal(h.ctx.timeoutMs, 600_000);
});

it("lists the pods CoCalc started by default, with RunPod's live status", async () => {
  const h = harness();
  await h.run("pods");
  await h.run("pods", "--ended");
  await h.run("pods", "--id", "cc-7f3k9q2x");
  assert.deepEqual(
    h.calls.map((c) => c.args),
    [{}, { include_ended: true }, { pod_id: "cc-7f3k9q2x" }],
  );
  assert.deepEqual(h.outputs[0], [RECORD_ROW]);
  assert.deepEqual(h.outputs[2], { ...RECORD, live: PODS.pods[0] });
});

it("launches from flags, in this project, with a write-sized timeout", async () => {
  const prev = process.env.COCALC_PROJECT_ID;
  process.env.COCALC_PROJECT_ID = RECORD.project_id;
  try {
    const h = harness();
    await h.run(
      "launch",
      "--gpu",
      "NVIDIA RTX A5000",
      "--max-runtime",
      "60",
      "--cloud",
      "community",
      "--port",
      "8888/http",
      "--env",
      "EPOCHS=3",
      "--env",
      "MODE=a=b",
    );
    const operation_id = (h.calls[0]?.args as any)?.operation_id;
    assert.match(operation_id, /^cli-[0-9a-f]{32}$/);
    assert.deepEqual(h.calls, [
      {
        name: "launch",
        args: {
          project_id: RECORD.project_id,
          operation_id,
          spec: {
            gpu_type_id: "NVIDIA RTX A5000",
            gpu_count: 1,
            image: "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404",
            max_runtime_minutes: 60,
            cloud: "COMMUNITY",
            ports: ["8888/http"],
            env: { EPOCHS: "3", MODE: "a=b" },
            // checked against the allowlist here too, with its defaults
            container_disk_gb: 20,
            volume_gb: 0,
          },
        },
      },
    ]);
    assert.ok(h.seen[0].rpcTimeoutMs >= 150_000);
    assert.deepEqual(h.outputs, [{ ...RECORD_ROW, status: null }]);
  } finally {
    if (prev == null) delete process.env.COCALC_PROJECT_ID;
    else process.env.COCALC_PROJECT_ID = prev;
  }
});

it("needs a project and a maximum runtime to launch", async () => {
  const prev = process.env.COCALC_PROJECT_ID;
  delete process.env.COCALC_PROJECT_ID;
  try {
    const h = harness();
    await assert.rejects(
      h.run("launch", "--gpu", "x", "--max-runtime", "5"),
      /--project is required/,
    );
    await assert.rejects(h.run("launch", "--gpu", "x", "--project", "p"));
    assert.deepEqual(h.calls, []);
  } finally {
    if (prev != null) process.env.COCALC_PROJECT_ID = prev;
  }
});

it("terminates and looks up a pod", async () => {
  const h = harness();
  await h.run("terminate", "cc-7f3k9q2x");
  await h.run("who", "pod_abc123");
  assert.deepEqual(h.calls, [
    { name: "terminate", args: { pod_id: "cc-7f3k9q2x" } },
    { name: "who", args: { query: "pod_abc123" } },
  ]);
  assert.deepEqual(h.outputs[0], { state: "terminated" });
  assert.deepEqual(h.outputs[1], [
    {
      ...RECORD_ROW,
      status: null,
      beneficiary: RECORD.beneficiary_account_id,
      key_owner: RECORD.key_owner_account_id,
      project: RECORD.project_id,
      events: "2026-10-27T21:00:00.000Z user create",
    },
  ]);
});

it("the kill switch pauses by default for the account, never for a project, and resume and report-compromised send what they should", async () => {
  const h = harness();
  await h.run("kill");
  await h.run("kill", "--no-pause");
  await h.run("kill", "--project", "00000000-1000-4000-8000-0000000000aa");
  await h.run("resume");
  await h.run("report-compromised");
  await h.run("report-compromised", "--confirm-cocalc-only");
  assert.deepEqual(h.calls, [
    { name: "killSwitch", args: { pause: true } },
    { name: "killSwitch", args: { pause: false } },
    {
      name: "killSwitch",
      args: { project_id: "00000000-1000-4000-8000-0000000000aa" },
    },
    { name: "resume", args: {} },
    { name: "reportCompromised", args: { confirm_cocalc_only: false } },
    { name: "reportCompromised", args: { confirm_cocalc_only: true } },
  ]);
  // terminating pods can take a while: the write-sized timeout
  assert.equal(h.seen[0].rpcTimeoutMs, GPU_POD_WRITE_RPC_TIMEOUT_MS);
  // the ordinary first answer (RunPod still accepts the key) carries the
  // owner's next steps in the command's output, not only its help
  assert.deepEqual(h.outputs.at(-1), {
    closed: false,
    awaiting_provider_revocation: true,
    provider_pods: 0,
    managed_pods: 0,
    warning: "check RunPod's Pods page once",
  });
});

it("account-checks shows the state, confirms or withdraws, never both", async () => {
  const h = harness();
  await h.run("account-checks");
  await h.run("account-checks", "--confirm");
  await h.run("account-checks", "--withdraw");
  assert.deepEqual(h.calls, [
    { name: "accountChecks", args: {} },
    { name: "confirmAccountChecks", args: { confirm: true } },
    { name: "confirmAccountChecks", args: { confirm: false } },
  ]);
  await assert.rejects(h.run("account-checks", "--confirm", "--withdraw"));
});

it("shows and changes the budget; none removes a limit", async () => {
  const h = harness();
  await h.run("budget");
  await h.run(
    "budget",
    "set",
    "--authorized",
    "10",
    "--max-hourly",
    "none",
    "--max-pods",
    "1",
    "--max-runtime",
    "none",
    "--expected-version",
    "3",
  );
  assert.deepEqual(h.calls, [
    { name: "budget", args: {} },
    {
      name: "setBudget",
      args: {
        change: {
          authorized_usd: "10",
          max_hourly_usd: null,
          max_concurrent_pods: 1,
          max_runtime_minutes: null,
        },
        expected_version: 3,
      },
    },
  ]);
  await assert.rejects(h.run("budget", "set"), /at least one limit/);
  await assert.rejects(
    h.run("budget", "set", "--max-pods", "1.5"),
    /whole number or none/,
  );
});

it("launch --ssh makes the key here and sends only its public key; terminate forgets the pod here", async () => {
  const { mkdtempSync, existsSync, readdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "gpu-cmd-ssh-"));
  const handle = "cc-abcdefgh234567ab";
  const calls: Array<{ name: string; args: any }> = [];
  const reflect: string[][] = [];
  const program = new Command()
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerGpuCommand(program, {
    connect: {
      home,
      runReflect: async (args) => {
        reflect.push(args);
        return { code: 0, stdout: "{}", stderr: "" };
      },
    },
    withContext: async (_cmd, _name, fn) => {
      await fn({
        globals: { json: true },
        timeoutMs: 600_000,
        rpcTimeoutMs: 30_000,
        hub: {
          gpu: {
            launch: async (args) => {
              calls.push({ name: "launch", args });
              return { ...RECORD, handle };
            },
            terminate: async (args) => {
              calls.push({ name: "terminate", args });
              return { state: "terminated" };
            },
            sshInfo: async (args) => {
              calls.push({ name: "sshInfo", args });
              return { handle, ready: false, state: "terminated" };
            },
          },
        },
      });
    },
  });
  const prev = process.env.COCALC_PROJECT_ID;
  process.env.COCALC_PROJECT_ID = RECORD.project_id;
  try {
    await program.parseAsync(
      [
        "gpu",
        "launch",
        "--gpu",
        "NVIDIA RTX A5000",
        "--max-runtime",
        "60",
        "--ssh",
      ],
      { from: "user" },
    );
  } finally {
    process.env.COCALC_PROJECT_ID = prev;
  }
  const dir = join(home, ".ssh", "cocalc-gpu");
  // only the public key went to the hub; the key is now named after the pod
  const sent = calls[0].args.spec.ssh_public_key;
  assert.match(sent, /^ssh-ed25519 \S+ cocalc-gpu$/);
  assert.ok(!JSON.stringify(calls).includes("PRIVATE KEY"));
  assert.ok(existsSync(join(dir, handle)));
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.startsWith("pending-")),
    [],
  );

  await program.parseAsync(["gpu", "terminate", handle], { from: "user" });
  assert.deepEqual(
    calls.slice(1).map((c) => c.name),
    ["terminate", "sshInfo"],
  );
  assert.ok(!existsSync(join(dir, handle)));
  assert.deepEqual(reflect.at(-1)?.slice(0, 4), [
    "jupyter",
    "target",
    "remove",
    handle,
  ]);
});

it("launch --ssh removes its pending key when the server refuses, and keeps it on a timeout", async () => {
  const { mkdtempSync, readdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const pending = (home: string) =>
    readdirSync(join(home, ".ssh", "cocalc-gpu")).filter((f) =>
      /^pending-[a-z2-7]+$/.test(f),
    );
  async function launchFailing(err: Error) {
    const home = mkdtempSync(join(tmpdir(), "gpu-cmd-refused-"));
    const program = new Command()
      .exitOverride()
      .configureOutput({ writeErr: () => {}, writeOut: () => {} });
    registerGpuCommand(program, {
      connect: { home },
      withContext: async (_cmd, _name, fn) => {
        await fn({
          globals: { json: true },
          timeoutMs: 600_000,
          rpcTimeoutMs: 30_000,
          hub: {
            gpu: {
              launch: async () => {
                throw err;
              },
              pods: async () => ({ records: [] }),
            },
          },
        });
      },
    });
    const prev = process.env.COCALC_PROJECT_ID;
    process.env.COCALC_PROJECT_ID = RECORD.project_id;
    try {
      await assert.rejects(
        program.parseAsync(
          [
            "gpu",
            "launch",
            "--gpu",
            "NVIDIA RTX A5000",
            "--max-runtime",
            "60",
            "--ssh",
          ],
          { from: "user" },
        ),
      );
    } finally {
      process.env.COCALC_PROJECT_ID = prev;
    }
    return pending(home);
  }
  assert.deepEqual(
    await launchFailing(new Error("No RunPod API key is connected.")),
    [],
  );
  assert.equal(
    (await launchFailing(Object.assign(new Error("timeout"), { code: 408 })))
      .length,
    1,
  );
});

it("lists templates, and a template dry run shows the GPU and the most it can cost", async () => {
  const h = harness();
  await h.run("templates");
  assert.ok((h.outputs[0] as any[]).some((t) => t.id === "pytorch-kernel"));
  const prev = process.env.COCALC_PROJECT_ID;
  process.env.COCALC_PROJECT_ID = RECORD.project_id;
  try {
    // the harness has no offers in stock
    await assert.rejects(
      h.run("launch", "--template", "pytorch-kernel", "--dry-run"),
      /No GPU with at least 16 GB is in stock/,
    );
    await h.run(
      "launch",
      "--template",
      "pytorch-ssh",
      "--gpu",
      "NVIDIA RTX A4000",
      "--dry-run",
    );
  } finally {
    process.env.COCALC_PROJECT_ID = prev;
  }
  const dry = h.outputs.at(-1) as any;
  assert.equal(dry.dry_run, true);
  assert.equal(dry.template, "pytorch-ssh");
  assert.equal(dry.ssh, true);
  assert.equal(dry.kernel, false);
  assert.equal(dry.spec.gpu_type_id, "NVIDIA RTX A4000");
  assert.equal(dry.spec.max_runtime_minutes, 60);
  assert.equal(dry.max_cost_usd, null);
  // no price, so no pinned next command
  assert.equal(dry.next, null);
  // nothing was launched
  assert.ok(!h.calls.some((c) => c.name === "launch"));
});

it("a kernel template launches with a key made here, then connects and registers the kernel", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "gpu-cmd-template-"));
  const handle = "cc-abcdefgh234567ab";
  const HOST_KEY =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
  const calls: Array<{ name: string; args: any }> = [];
  const reflect: string[][] = [];
  const outputs: any[] = [];
  const program = new Command()
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} });
  let fingerprint = "";
  registerGpuCommand(program, {
    connect: {
      home,
      sleep: async () => {},
      runReflect: async (args) => {
        reflect.push(args);
        return {
          code: 0,
          stdout: JSON.stringify({ kernel: `reflect-${handle}` }),
          stderr: "",
        };
      },
    },
    withContext: async (_cmd, _name, fn) => {
      outputs.push(
        await fn({
          globals: { json: true },
          timeoutMs: 600_000,
          rpcTimeoutMs: 30_000,
          hub: {
            gpu: {
              availability: async (args) => {
                calls.push({ name: "availability", args });
                return {
                  offers: [
                    {
                      gpu_type_id: "NVIDIA RTX A4000",
                      gpu_name: "RTX A4000",
                      memory_gb: 16,
                      cloud: "SECURE",
                      data_center_id: "EU-RO-1",
                      stock: "HIGH",
                      price_per_gpu_hour: 0.25,
                    },
                  ],
                };
              },
              launch: async (args) => {
                calls.push({ name: "launch", args });
                const { keyFingerprint } = await import("../core/gpu-ssh");
                fingerprint = keyFingerprint(args.spec.ssh_public_key);
                return {
                  ...RECORD,
                  handle,
                  gpu_type_id: args.spec.gpu_type_id,
                };
              },
              sshInfo: async () => ({
                handle,
                state: "running",
                ready: true,
                host: "203.0.113.7",
                port: 40022,
                user: "root",
                host_public_key: HOST_KEY,
                ssh_key_fingerprint: fingerprint,
              }),
            },
          },
        }),
      );
    },
  });
  const prev = process.env.COCALC_PROJECT_ID;
  process.env.COCALC_PROJECT_ID = RECORD.project_id;
  try {
    await program.parseAsync(
      ["gpu", "launch", "--template", "pytorch-kernel"],
      {
        from: "user",
      },
    );
  } finally {
    process.env.COCALC_PROJECT_ID = prev;
  }
  const launch = calls.find((c) => c.name === "launch")!;
  assert.equal(launch.args.spec.gpu_type_id, "NVIDIA RTX A4000");
  assert.equal(launch.args.spec.max_runtime_minutes, 60);
  assert.match(launch.args.spec.ssh_public_key, /^ssh-ed25519 /);
  const out = outputs[0];
  assert.equal(out.handle, handle);
  // the GPU hour and the 20 GB disk, rounded up
  assert.equal(out.max_cost_usd, 0.26);
  assert.equal(out.connect.kernel, `reflect-${handle}`);
  assert.equal(reflect.at(-1)![2], "add");
});

// A program whose hub records launches, with offers in stock and pod keys in
// a temporary home; `cocalc gpu ...` command lines run as a shell would
// split them.
async function launchHarness({
  billed,
  noRate = false,
  reflectFails = false,
  terminateFails = false,
}: {
  billed?: string;
  noRate?: boolean;
  reflectFails?: boolean;
  terminateFails?: boolean;
} = {}) {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const home = mkdtempSync(join(tmpdir(), "gpu-cmd-next-"));
  const calls: Array<{ name: string; args: any }> = [];
  const outputs: any[] = [];
  let launches = 0;
  let handle = "";
  const program = new Command()
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} });
  const offer = (
    gpu_type_id: string,
    memory_gb: number,
    price: number,
    cloud = "SECURE",
  ) => ({
    gpu_type_id,
    gpu_name: gpu_type_id,
    memory_gb,
    cloud,
    data_center_id: "EU-RO-1",
    stock: "HIGH",
    price_per_gpu_hour: price,
  });
  registerGpuCommand(program, {
    connect: {
      home,
      sleep: async () => {},
      runReflect: async () => {
        if (reflectFails) throw new Error("reflect is broken");
        return { code: 0, stdout: "{}", stderr: "" };
      },
    },
    withContext: async (_cmd, _name, fn) => {
      outputs.push(
        await fn({
          globals: { json: true },
          timeoutMs: 600_000,
          rpcTimeoutMs: 30_000,
          hub: {
            gpu: {
              availability: async (args) => {
                calls.push({ name: "availability", args });
                return {
                  offers: [
                    offer("NVIDIA RTX A4000", 16, 0.25),
                    offer("NVIDIA RTX A4000", 16, 0.17, "COMMUNITY"),
                    offer("NVIDIA L40S", 48, 0.86),
                  ].filter(
                    (o) =>
                      (!args.cloud || o.cloud === args.cloud) &&
                      (!args.gpu || args.gpu.includes(o.gpu_type_id)),
                  ),
                };
              },
              launch: async (args) => {
                calls.push({ name: "launch", args });
                // a new handle per pod, so each pod's key is its own
                handle = `cc-${"abcdefghijklmnop".slice(0, 15)}${"abcdefghijklmnopqrstuvwxyz"[launches++]}`;
                const pod: any = { ...RECORD, handle, state: "running" };
                if (noRate) delete pod.cost_per_hr;
                else pod.cost_per_hr = billed ?? "0.25";
                return pod;
              },
              terminate: async (args) => {
                calls.push({ name: "terminate", args });
                if (terminateFails) throw new Error("hub call failed");
                return { state: "terminating" };
              },
              sshInfo: async (args) => {
                calls.push({ name: "sshInfo", args });
                return {
                  handle,
                  state: "running",
                  ready: true,
                  host: "203.0.113.7",
                  port: 40022,
                  user: "root",
                  host_public_key:
                    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
                };
              },
            },
          },
        }),
      );
    },
  });
  // a command line as /bin/sh splits it
  const words = (line: string): string[] =>
    execFileSync(
      "sh",
      [
        "-c",
        'eval "set -- $1"; for a; do printf "%s\\0" "$a"; done',
        "sh",
        line,
      ],
      { encoding: "utf8" },
    )
      .split("\0")
      .slice(0, -1);
  const run = async (line: string) => {
    const w = words(line);
    assert.deepEqual(w.slice(0, 2), ["cocalc", "gpu"]);
    await program.parseAsync(w.slice(1), { from: "user" });
    return outputs.at(-1);
  };
  return { calls, outputs, run, words };
}

it("a dry run's next is exactly its launch: every option, the project, SSH and connect behavior", async () => {
  const OTHER_PROJECT = "00000000-1000-4000-8000-0000000000bb";
  const h = await launchHarness();
  const cases = [
    // a template with every override, for another project, values a shell would mangle
    `cocalc gpu launch --dry-run --project ${OTHER_PROJECT} --template pytorch-kernel --cloud community --data-center EU-RO-1 --gpu "NVIDIA RTX A4000" --count 2 --disk 30 --volume 50 --port 8888/http --port 6006/http --env 'NOTE=a b; $(echo no) "q" '"'"'x'"'"'' --env EPOCHS=3 --max-runtime 45 --no-connect --wait 120`,
    // no template, with --ssh
    `cocalc gpu launch --dry-run --project ${OTHER_PROJECT} --gpu "NVIDIA L40S" --max-runtime 30 --ssh`,
    // a kernel template, defaults
    `cocalc gpu launch --dry-run --project ${OTHER_PROJECT} --template pytorch-kernel`,
  ];
  for (const line of cases) {
    const dry = await h.run(line);
    assert.equal(dry.dry_run, true);
    assert.ok(dry.next, line);
    const before = h.calls.length;
    const out = await h.run(dry.next);
    const launch = h.calls.slice(before).find((c) => c.name === "launch")!;
    assert.ok(launch, dry.next);
    assert.equal(launch.args.project_id, OTHER_PROJECT);
    // the same spec, apart from the key made at launch
    const { ssh_public_key, ...sent } = launch.args.spec;
    assert.deepEqual(sent, dry.spec, dry.next);
    assert.equal(!!ssh_public_key, dry.ssh, dry.next);
    assert.equal(out.max_cost_usd, dry.max_cost_usd);
    // connect only where the dry run said it would
    const connected = h.calls.slice(before).some((c) => c.name === "sshInfo");
    assert.equal(connected, dry.kernel, dry.next);
    assert.match(
      dry.next,
      new RegExp(`--max-cost ${dry.max_cost_usd.toFixed(2)}$`),
    );
  }
  // the odd env value survived the shell
  const first = (await h.run(cases[0])).spec.env;
  assert.equal(first.NOTE, `a b; $(echo no) "q" 'x'`);
});

it("terminates a pod at once if RunPod bills it above --max-cost", async () => {
  const PROJECT = "00000000-1000-4000-8000-0000000000bb";
  // listed at 0.25/h (bound 0.26), billed at 0.40/h: bound 0.41
  const h = await launchHarness({ billed: "0.40" });
  const dry = await h.run(
    `cocalc gpu launch --dry-run --project ${PROJECT} --template pytorch-ssh --gpu "NVIDIA RTX A4000"`,
  );
  assert.equal(dry.max_cost_usd, 0.26);
  await assert.rejects(
    h.run(dry.next),
    /billed cc-\S+ at \$0\.4\/h, so it could cost up to \$0\.41, more than --max-cost \$0\.26; it was terminated/,
  );
  const terminated = h.calls.find((c) => c.name === "terminate");
  assert.ok(terminated);
  // within the bound: kept
  const ok = await launchHarness({ billed: "0.25" });
  const dry2 = await ok.run(
    `cocalc gpu launch --dry-run --project ${PROJECT} --template pytorch-ssh --gpu "NVIDIA RTX A4000"`,
  );
  await ok.run(dry2.next);
  assert.ok(!ok.calls.some((c) => c.name === "terminate"));
});

it("with --max-cost, a pod whose billed rate can't be verified is terminated too", async () => {
  const PROJECT = "00000000-1000-4000-8000-0000000000bb";
  const dryLine = `cocalc gpu launch --dry-run --project ${PROJECT} --template pytorch-ssh --gpu "NVIDIA RTX A4000"`;
  for (const opts of [
    { noRate: true },
    { billed: "" },
    { billed: "n/a" },
    { billed: "-1" },
  ]) {
    const h = await launchHarness(opts);
    const dry = await h.run(dryLine);
    await assert.rejects(
      h.run(dry.next),
      /RunPod didn't report a billed rate for cc-\S+, so it can't be held to --max-cost \$0\.26; it was terminated\./,
      JSON.stringify(opts),
    );
    assert.ok(
      h.calls.some((c) => c.name === "terminate"),
      JSON.stringify(opts),
    );
  }
});

it("a local cleanup failure after the terminate doesn't change what is reported", async () => {
  const PROJECT = "00000000-1000-4000-8000-0000000000bb";
  const dryLine = `cocalc gpu launch --dry-run --project ${PROJECT} --template pytorch-ssh --gpu "NVIDIA RTX A4000"`;
  // RunPod terminated it; forgetting it here failed: still "terminated"
  const h = await launchHarness({ billed: "0.40", reflectFails: true });
  const dry = await h.run(dryLine);
  await assert.rejects(
    h.run(dry.next),
    /more than --max-cost \$0\.26; it was terminated\./,
  );
  // the terminate itself failed: say so, with the command to run
  const t = await launchHarness({ billed: "0.40", terminateFails: true });
  const dry2 = await t.run(dryLine);
  await assert.rejects(
    t.run(dry2.next),
    /more than --max-cost \$0\.26; terminating it failed: run cocalc gpu terminate cc-\S+\./,
  );
});

const ALERT = {
  id: "00000000-1000-4000-8000-0000000000bb",
  credential_id: "00000000-1000-4000-8000-0000000000cc",
  kind: "unmanaged_pod",
  severity: "warning",
  message: "Terminate it at RunPod, then acknowledge this alert.",
  details: { handle: "cocalc-gpu-abc" },
  opened: "2026-10-28T20:00:00.000Z",
  last_seen: "2026-10-28T20:00:00.000Z",
  resolved_at: null,
  resolved_by: null,
  acknowledged_at: null,
  acknowledgeable: true,
};

it("lists alerts (and recent resolved ones), acknowledges one, and releases a quarantined hold", async () => {
  const h = harness();
  await h.run("alerts");
  await h.run("alerts", "--all");
  await h.run("alerts", "ack", ALERT.id);
  await h.run("release-quarantined", "cocalc-gpu-abc");
  assert.deepEqual(h.calls, [
    { name: "alerts", args: {} },
    { name: "alerts", args: { include_resolved: true } },
    { name: "acknowledgeAlert", args: { id: ALERT.id } },
    { name: "releaseQuarantined", args: { pod_id: "cocalc-gpu-abc" } },
  ]);
  assert.deepEqual(h.outputs[0], [
    {
      id: ALERT.id,
      severity: "warning",
      kind: "unmanaged_pod",
      opened: ALERT.opened,
      last_seen: ALERT.last_seen,
      resolved: null,
      acknowledgeable: "yes",
      pod: "cocalc-gpu-abc",
      message: ALERT.message,
    },
  ]);
  assert.equal((h.outputs[2] as any).resolved, "2026-10-28T21:00:00.000Z");
});

it("gpu agent requests shows the exact launch and hash, and names a session as this chat session", async () => {
  const h = harness();
  await h.run("agent", "requests", "--all");
  assert.deepEqual(h.calls, [
    { name: "agentRequests", args: { include_decided: true } },
  ]);
  const [row] = h.outputs[0] as any[];
  assert.equal(row.agent, "this chat session");
  assert.equal(row.hash, "a".repeat(64));
  assert.equal(row.gpu, "1 x NVIDIA RTX A5000");
  assert.equal(row.max_cost_usd, "0.30");
  const json = harness({ json: true });
  await json.run("agent", "requests");
  assert.deepEqual(json.outputs[0], [AGENT_REQUEST]);
});

it("gpu agent approve needs the reviewed hash; revoke takes the grant", async () => {
  const h = harness();
  await assert.rejects(h.run("agent", "approve", "r1"));
  assert.deepEqual(h.calls, []);
  await h.run("agent", "approve", "r1", "--hash", "b".repeat(64));
  await h.run("agent", "revoke", "g1");
  assert.deepEqual(h.calls, [
    {
      name: "approveAgentRequest",
      args: { request_id: "r1", expected_hash: "b".repeat(64) },
    },
    { name: "revokeAgentGrant", args: { grant_id: "g1" } },
  ]);
});

it("a launch's operation id is stable for the same launch, and --operation overrides it", async () => {
  const base = [
    "launch",
    "--project",
    "00000000-1000-4000-8000-0000000000aa",
    "--gpu",
    "NVIDIA RTX A5000",
    "--max-runtime",
    "60",
  ];
  const a = harness();
  await a.run(...base);
  const b = harness();
  await b.run(
    ...base,
    "--ssh-public-key",
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
  );
  const c = harness();
  await c.run(...base, "--count", "2");
  const d = harness();
  await d.run(...base, "--operation", "my-op");
  const op = (h: any) =>
    h.calls.find((x: any) => x.name === "launch").args.operation_id;
  assert.match(op(a), /^cli-[0-9a-f]{32}$/);
  // the pod's SSH key doesn't change it; the launch does
  assert.equal(op(b), op(a));
  assert.notEqual(op(c), op(a));
  assert.equal(op(d), "my-op");
});
