import assert from "node:assert/strict";
import { it } from "node:test";
import {
  pinnedLaunchCommand,
  planGpuLaunch,
  shellQuote,
  templateRows,
} from "./gpu-template";

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
  // the GPU hour plus its 20 GB disk: 0.24 + 20 x 0.20/672 = 0.2460
  assert.equal(small.max_cost_usd, 0.25);
  assert.deepEqual(a.calls[0], { cloud: "SECURE", min_count: 1 });

  // explicit choices win over the template; no price, no offer
  const big = await planGpuLaunch(a, {
    template: "llm-kernel",
    spec: { max_runtime_minutes: 45, gpu_count: 2 },
  });
  assert.equal(big.spec.gpu_type_id, "NVIDIA A40");
  assert.equal(big.spec.gpu_count, 2);
  assert.equal(big.spec.container_disk_gb, 80);
  // 0.75 h x (0.44 x 2 + 80 GB x 0.20/672) = 0.6779; GPUs alone: 0.66
  assert.equal(big.max_cost_usd, 0.68);
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
  // 0.5 h x (0.25 + 20 GB x 0.20/672) = 0.1280
  assert.equal(priced.max_cost_usd, 0.13);
  // with a 100 GB volume: 0.5 h x (0.25 + 120 GB x 0.20/672) = 0.1429
  const withVolume = await planGpuLaunch(a, {
    spec: {
      gpu_type_id: "NVIDIA RTX A4000",
      max_runtime_minutes: 30,
      volume_gb: 100,
    },
    price: true,
  });
  assert.equal(withVolume.max_cost_usd, 0.15);
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

it("holds a launch to --max-cost, and pins a dry run's choice in its next command", async () => {
  const cheap = api([offer("NVIDIA RTX A4000", 16, 0.25)]);
  const dry = await planGpuLaunch(cheap, {
    template: "pytorch-kernel",
    spec: {},
    price: true,
  });
  assert.equal(dry.max_cost_usd, 0.26);
  const next = pinnedLaunchCommand(dry, {
    project_id: "00000000-1000-4000-8000-0000000000aa",
    template: "pytorch-kernel",
  })!;
  assert.equal(
    next,
    "cocalc gpu launch --project 00000000-1000-4000-8000-0000000000aa --template pytorch-kernel --gpu 'NVIDIA RTX A4000' --count 1 --cloud SECURE --image runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404 --disk 20 --max-runtime 60 --max-cost 0.26",
  );
  // the same launch later, at the stated bound: fine
  const ok = await planGpuLaunch(cheap, {
    template: "pytorch-kernel",
    spec: { gpu_type_id: "NVIDIA RTX A4000", max_runtime_minutes: 60 },
    max_cost_usd: 0.26,
  });
  assert.equal(ok.spec.gpu_type_id, "NVIDIA RTX A4000");
  // the price rose since the dry run: refused
  await assert.rejects(
    planGpuLaunch(api([offer("NVIDIA RTX A4000", 16, 0.4)]), {
      template: "pytorch-kernel",
      spec: { gpu_type_id: "NVIDIA RTX A4000", max_runtime_minutes: 60 },
      max_cost_usd: 0.26,
    }),
    /could cost up to \$0\.41, more than --max-cost \$0\.26/,
  );
  // no price known: refused, the bound can't be checked
  await assert.rejects(
    planGpuLaunch(api([]), {
      spec: { gpu_type_id: "NVIDIA RTX A4000", max_runtime_minutes: 60 },
      max_cost_usd: 1,
    }),
    /can't be held to --max-cost/,
  );
  // without --gpu, the cheapest pick is held to it too
  await assert.rejects(
    planGpuLaunch(api([offer("NVIDIA L40S", 48, 0.86)]), {
      template: "llm-kernel",
      spec: {},
      max_cost_usd: 1,
    }),
    /more than --max-cost/,
  );
  // no price, no pinned command
  assert.equal(
    pinnedLaunchCommand(
      await planGpuLaunch(api([]), {
        spec: { gpu_type_id: "NVIDIA RTX A4000", max_runtime_minutes: 60 },
      }),
      { project_id: "00000000-1000-4000-8000-0000000000aa" },
    ),
    undefined,
  );
});

it("quotes every value for a POSIX shell", () => {
  assert.equal(shellQuote("EU-RO-1"), "EU-RO-1");
  assert.equal(shellQuote("NVIDIA RTX A4000"), "'NVIDIA RTX A4000'");
  assert.equal(shellQuote(`a'b $(x) "c"`), `'a'\\''b $(x) "c"'`);
  assert.equal(shellQuote(""), "''");
});
