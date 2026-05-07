import { buildCreateHostPayload, isNebiusSpotSupported } from "./registry";

describe("buildCreateHostPayload", () => {
  it("adds derived cpu and ram metadata for gcp machine types", () => {
    const payload = buildCreateHostPayload(
      {
        provider: "gcp",
        name: "GCP Host",
        region: "us-west1",
        zone: "us-west1-a",
        machine_type: "t2d-standard-2",
      },
      {
        fieldOptions: {
          region: [{ value: "us-west1", label: "US West 1" }],
          zone: [{ value: "us-west1-a", label: "US West 1A" }],
          machine_type: [
            {
              value: "t2d-standard-2",
              label: "t2d-standard-2",
              meta: { guestCpus: 2, memoryMb: 8192 },
            },
          ],
        },
      },
    );

    expect(payload.machine?.metadata).toMatchObject({
      cpu: 2,
      ram_gb: 8,
    });
  });

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
        spot_recovery_policy: {
          spot_restore_retry_window_minutes: 5,
        },
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
    expect(payload.spot_recovery_policy).toBeUndefined();
  });

  it("includes the spot recovery policy for spot auto-restore hosts", () => {
    const payload = buildCreateHostPayload(
      {
        provider: "gcp",
        name: "Spot Host",
        region: "us-west1",
        size: "n2-standard-4",
        pricing_model: "spot",
        interruption_restore_policy: "immediate",
        spot_recovery_policy: {
          spot_restore_retry_window_minutes: 5,
          standard_fallback_enabled: false,
        },
      },
      {
        fieldOptions: {
          region: [{ value: "us-west1", label: "US West 1" }],
          size: [{ value: "n2-standard-4", label: "n2-standard-4" }],
        },
      },
    );

    expect(payload.spot_recovery_policy).toMatchObject({
      spot_restore_retry_window_minutes: 5,
      standard_fallback_enabled: false,
    });
  });
});

describe("isNebiusSpotSupported", () => {
  it("returns false when the selected Nebius instance explicitly disallows preemptibles", () => {
    expect(
      isNebiusSpotSupported(
        [
          {
            value: "cpu-d3-standard-4",
            label: "CPU D3",
            meta: { allowed_for_preemptibles: false },
          },
        ],
        "cpu-d3-standard-4",
      ),
    ).toBe(false);
  });

  it("defaults to true when the catalog entry does not declare the capability", () => {
    expect(
      isNebiusSpotSupported(
        [
          {
            value: "unknown",
            label: "Unknown",
            meta: {},
          },
        ],
        "unknown",
      ),
    ).toBe(true);
  });
});
