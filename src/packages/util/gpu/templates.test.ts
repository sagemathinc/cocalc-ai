import { normalizeGpuLaunchSpec } from "./launch-spec";
import {
  GPU_TEMPLATES,
  STORAGE_USD_PER_GB_HOUR_BOUND,
  getGpuTemplate,
  maxLaunchCostUsd,
  specFromTemplate,
} from "./templates";

describe("GPU templates", () => {
  it("are all valid launch specs once a GPU is chosen", () => {
    for (const t of GPU_TEMPLATES) {
      const spec = normalizeGpuLaunchSpec(
        specFromTemplate(t, { gpu_type_id: "NVIDIA RTX A4000" }),
      );
      expect(spec.image).toBe(t.spec.image);
      expect(spec.max_runtime_minutes).toBe(t.spec.max_runtime_minutes);
    }
  });

  it("have unique ids and never carry a GPU type or a key", () => {
    const ids = GPU_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of GPU_TEMPLATES) {
      expect(t.id).toMatch(/^[a-z][a-z0-9-]{1,31}$/);
      expect(t.spec).not.toHaveProperty("gpu_type_id");
      expect(t.spec).not.toHaveProperty("ssh_public_key");
      // a kernel needs SSH
      if (t.kernel) expect(t.ssh).toBe(true);
      expect(t.min_gpu_memory_gb).toBeGreaterThan(0);
    }
  });

  it("lets explicit choices win, merging env", () => {
    const t = getGpuTemplate("llm-kernel")!;
    const spec = specFromTemplate(
      { ...t, spec: { ...t.spec, env: { A: "1", B: "2" } } },
      {
        gpu_type_id: "NVIDIA A40",
        max_runtime_minutes: 30,
        env: { B: "3" },
        cloud: undefined,
      },
    );
    expect(spec).toEqual({
      ...t.spec,
      gpu_type_id: "NVIDIA A40",
      max_runtime_minutes: 30,
      env: { A: "1", B: "3" },
    });
    expect(getGpuTemplate("nope")).toBeUndefined();
  });

  it("bounds the cost by the GPUs and all disk for the whole runtime, rounded up", () => {
    const cost = (o: Partial<Parameters<typeof maxLaunchCostUsd>[0]>) =>
      maxLaunchCostUsd({
        price_per_gpu_hour: 0,
        gpu_count: 1,
        max_runtime_minutes: 60,
        container_disk_gb: 0,
        volume_gb: 0,
        ...o,
      });
    // GPUs only: 0.40 x 2 x 1.5 h
    expect(
      cost({ price_per_gpu_hour: 0.4, gpu_count: 2, max_runtime_minutes: 90 }),
    ).toBe(1.2);
    // the default 20 GB disk alone, for an hour: 20 x 0.20/672 = $0.006
    expect(cost({ container_disk_gb: 20 })).toBe(0.01);
    expect(STORAGE_USD_PER_GB_HOUR_BOUND).toBeCloseTo(0.2 / 672, 12);
    // llm-kernel's 80 GB disk for 2 h moves the bound past GPU-only
    // (0.44 x 2 h = 0.88): 2 x (0.44 + 80 x 0.20/672) = 0.9276
    expect(
      cost({
        price_per_gpu_hour: 0.44,
        max_runtime_minutes: 120,
        container_disk_gb: 80,
      }),
    ).toBe(0.93);
    // a volume counts too: 520 GB for an hour = $0.155
    expect(cost({ container_disk_gb: 20, volume_gb: 500 })).toBe(0.16);
  });
});
