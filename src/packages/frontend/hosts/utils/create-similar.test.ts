import type { Host } from "@cocalc/conat/hub/api/hosts";
import { buildCreateSimilarHostFormValues } from "./create-similar";

describe("buildCreateSimilarHostFormValues", () => {
  it("copies the relevant cloud host fields into create-form values", () => {
    const values = buildCreateSimilarHostFormValues(
      {
        id: "host-1",
        name: "GPU Builder",
        region: "us-west1",
        size: "n2-standard-8",
        pricing_model: "spot",
        machine: {
          cloud: "gcp",
          zone: "us-west1-b",
          machine_type: "n2-standard-8",
          gpu_type: "nvidia-l4",
          disk_gb: 250,
          disk_type: "ssd",
          storage_mode: "persistent",
          metadata: {
            cpu: 8,
            ram_gb: 32,
            auto_grow: {
              enabled: true,
              max_disk_gb: 1000,
              growth_step_gb: 100,
              min_grow_interval_minutes: 45,
            },
          },
        },
      } as unknown as Host,
      ["gcp", "self-host"],
    );

    expect(values).toMatchObject({
      name: "GPU Builder (similar)",
      provider: "gcp",
      region: "us-west1",
      zone: "us-west1-b",
      machine_type: "n2-standard-8",
      gpu_type: "nvidia-l4",
      disk: 250,
      disk_gb: 250,
      pricing_model: "spot",
      interruption_restore_policy: "immediate",
      auto_grow_enabled: true,
      auto_grow_max_disk_gb: 1000,
      auto_grow_growth_step_gb: 100,
      auto_grow_min_grow_interval_minutes: 45,
    });
  });

  it("preserves an existing similar suffix and falls back to the first allowed provider", () => {
    const values = buildCreateSimilarHostFormValues(
      {
        id: "host-2",
        name: "Edge Host (similar)",
        pricing_model: "on_demand",
        machine: {
          cloud: "lambda",
          metadata: {
            self_host_ssh_target: "user@example",
          },
        },
      } as unknown as Host,
      ["self-host", "gcp"],
    );

    expect(values.name).toBe("Edge Host (similar)");
    expect(values.provider).toBe("self-host");
    expect(values.interruption_restore_policy).toBe("none");
  });
});
