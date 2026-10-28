import { normalizeGpuLaunchSpec } from "./launch-spec";
import {
  GPU_TEMPLATES,
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

  it("bounds the cost by list price, GPU count and maximum runtime", () => {
    expect(maxLaunchCostUsd(0.4, 2, 90)).toBeCloseTo(1.2);
  });
});
