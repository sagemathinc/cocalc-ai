import assert from "node:assert/strict";
import { it } from "node:test";
import { Command } from "commander";
import { registerGpuCommand } from "./gpu";

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

function harness(globals: Record<string, unknown> = {}) {
  const calls: Array<{ name: string; args: unknown }> = [];
  const outputs: unknown[] = [];
  const program = new Command()
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerGpuCommand(program, {
    withContext: async (_cmd, _name, fn) => {
      outputs.push(
        await fn({
          globals,
          hub: {
            gpu: {
              catalog: async (args) => {
                calls.push({ name: "catalog", args });
                return CATALOG;
              },
              availability: async (args) => {
                calls.push({ name: "availability", args });
                return { provider: "runpod", as_of: "x", offers: [] };
              },
              pods: async (args) => {
                calls.push({ name: "pods", args });
                return PODS;
              },
            },
          },
        }),
      );
    },
  });
  return {
    calls,
    outputs,
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
  await table.run("pods");
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
  await json.run("pods");
  assert.deepEqual(json.outputs, [CATALOG, PODS]);
});

it("reads one pod by id", async () => {
  const h = harness();
  await h.run("pods", "--id", "pod_abc123");
  assert.deepEqual(h.calls, [{ name: "pods", args: { pod_id: "pod_abc123" } }]);
  assert.deepEqual(h.outputs, [PODS.pods[0]]);
});
