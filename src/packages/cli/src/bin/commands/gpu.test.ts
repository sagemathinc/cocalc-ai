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
    assert.deepEqual(h.calls, [
      {
        name: "launch",
        args: {
          project_id: RECORD.project_id,
          spec: {
            gpu_type_id: "NVIDIA RTX A5000",
            gpu_count: 1,
            image: "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404",
            max_runtime_minutes: 60,
            cloud: "COMMUNITY",
            ports: ["8888/http"],
            env: { EPOCHS: "3", MODE: "a=b" },
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
