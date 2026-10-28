import assert from "node:assert/strict";
import { it } from "node:test";
import { planGpuLaunch, templateRows } from "./gpu-template";

const offer = (
  gpu_type_id: string,
  memory_gb: number,
  price_per_gpu_hour?: number,
) => ({
  gpu_type_id,
  gpu_name: gpu_type_id,
  memory_gb,
  cloud: "SECURE" as const,
  data_center_id: "EU-RO-1",
  stock: "HIGH" as const,
  ...(price_per_gpu_hour != null ? { price_per_gpu_hour } : {}),
});

function api(offers: any[]) {
  const calls: any[] = [];
  return {
    calls,
    availability: async (filter: any) => {
      calls.push(filter);
      return { provider: "runpod", as_of: "x", offers } as any;
    },
  };
}

it("picks the cheapest GPU in stock with the template's memory, and bounds the cost", async () => {
  const a = api([
    offer("NVIDIA RTX 2000 Ada Generation", 16, 0.24),
    offer("NVIDIA RTX A2000", 6, 0.1),
    offer("NVIDIA A40", 48, 0.44),
    offer("NVIDIA L40S", 48, 0.86),
    offer("NVIDIA RTX A6000", 48),
  ]);
  const small = await planGpuLaunch(a, {
    template: "pytorch-kernel",
    spec: {},
  });
  assert.equal(small.spec.gpu_type_id, "NVIDIA RTX 2000 Ada Generation");
  assert.equal(small.spec.max_runtime_minutes, 60);
  assert.equal(small.spec.cloud, "SECURE");
  assert.equal(small.max_cost_usd, 0.24);
  assert.deepEqual(a.calls[0], { cloud: "SECURE", min_count: 1 });

  // explicit choices win over the template; no price, no offer
  const big = await planGpuLaunch(a, {
    template: "llm-kernel",
    spec: { max_runtime_minutes: 45, gpu_count: 2 },
  });
  assert.equal(big.spec.gpu_type_id, "NVIDIA A40");
  assert.equal(big.spec.gpu_count, 2);
  assert.equal(big.spec.container_disk_gb, 80);
  // 0.44 x 2 x 45/60, rounded up to the cent
  assert.equal(big.max_cost_usd, 0.66);
  assert.deepEqual(a.calls[1], { cloud: "SECURE", min_count: 2 });
});

it("says when nothing with enough memory is in stock", async () => {
  await assert.rejects(
    planGpuLaunch(api([offer("NVIDIA RTX A4000", 16, 0.25)]), {
      template: "llm-kernel",
      spec: {},
    }),
    /No GPU with at least 48 GB is in stock on SECURE cloud now/,
  );
});

it("prices a given GPU only when asked, and needs a GPU and runtime without a template", async () => {
  const a = api([
    offer("NVIDIA RTX A4000", 16, 0.3),
    offer("NVIDIA RTX A4000", 16, 0.25),
  ]);
  const quiet = await planGpuLaunch(a, {
    template: "pytorch-ssh",
    spec: { gpu_type_id: "NVIDIA RTX A4000" },
  });
  assert.equal(quiet.offer, undefined);
  assert.equal(a.calls.length, 0);
  const priced = await planGpuLaunch(a, {
    spec: { gpu_type_id: "NVIDIA RTX A4000", max_runtime_minutes: 30 },
    price: true,
  });
  assert.equal(priced.max_cost_usd, 0.13);
  assert.deepEqual(a.calls[0], {
    cloud: "SECURE",
    min_count: 1,
    gpu: ["NVIDIA RTX A4000"],
  });
  await assert.rejects(
    planGpuLaunch(a, { spec: { max_runtime_minutes: 30 } }),
    /--gpu is required/,
  );
  await assert.rejects(
    planGpuLaunch(a, { spec: { gpu_type_id: "NVIDIA RTX A4000" } }),
    /--max-runtime is required/,
  );
  await assert.rejects(
    planGpuLaunch(a, { template: "nope", spec: {} }),
    /no template "nope"; choose one of: pytorch-kernel/,
  );
  // the allowlist still applies
  await assert.rejects(
    planGpuLaunch(a, {
      template: "pytorch-ssh",
      spec: { gpu_type_id: "NVIDIA RTX A4000", env: { API_TOKEN: "x" } },
    }),
    /looks like a credential/,
  );
});

it("lists the templates", () => {
  const rows = templateRows();
  assert.ok(rows.some((r) => r.id === "pytorch-kernel" && r.kernel));
});
