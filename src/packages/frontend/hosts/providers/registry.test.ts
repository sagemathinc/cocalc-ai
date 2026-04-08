import { buildCreateHostPayload } from "./registry";

describe("buildCreateHostPayload", () => {
  it("preserves disk_gb from the host edit form for nebius", () => {
    const payload = buildCreateHostPayload(
      {
        provider: "nebius",
        name: "Nebius Host",
        region: "eu-north1",
        machine_type: "cpu-standard",
        disk_gb: 93,
        disk_type: "ssd_io_m3",
      },
      {
        fieldOptions: {
          region: [{ value: "eu-north1", label: "EU North" }],
          machine_type: [
            {
              value: "cpu-standard",
              label: "CPU Standard",
              meta: { gpus: 0 },
            },
          ],
        },
      },
    );

    expect(payload.machine?.disk_gb).toBe(93);
    expect(payload.pricing_model).toBe("on_demand");
    expect(payload.interruption_restore_policy).toBe("immediate");
  });

  it("includes explicit spot pricing fields", () => {
    const payload = buildCreateHostPayload(
      {
        provider: "gcp",
        name: "Spot Host",
        region: "us-west1",
        size: "n2-standard-4",
        pricing_model: "spot",
        interruption_restore_policy: "none",
      },
      {
        fieldOptions: {
          region: [{ value: "us-west1", label: "US West 1" }],
          size: [{ value: "n2-standard-4", label: "n2-standard-4" }],
        },
      },
    );

    expect(payload.pricing_model).toBe("spot");
    expect(payload.interruption_restore_policy).toBe("none");
  });
});
