import { buildHostEditSelection } from "./host-edit-modal";

describe("buildHostEditSelection", () => {
  it("falls back to the host disk metadata for stopped GCP hosts", () => {
    const selection = buildHostEditSelection({
      host: {
        region: "us-west1",
        funding_mode: "account-postpaid",
        pricing_model: "on_demand",
        machine: {
          zone: "us-west1-a",
          machine_type: "n2d-standard-4",
          disk_type: "standard",
          disk_gb: 100,
          storage_mode: "persistent",
        },
      } as any,
      price_display: "hourly",
      pricing_settings: {},
    });

    expect(selection.region).toBe("us-west1");
    expect(selection.zone).toBe("us-west1-a");
    expect(selection.machine_type).toBe("n2d-standard-4");
    expect(selection.disk_type).toBe("standard");
    expect(selection.disk_gb).toBe(100);
    expect(selection.storage_mode).toBe("persistent");
  });

  it("falls back to the host disk metadata for stopped Nebius hosts", () => {
    const selection = buildHostEditSelection({
      host: {
        region: "eu-north1",
        funding_mode: "account-postpaid",
        pricing_model: "on_demand",
        machine: {
          machine_type: "cpu-standard-v3",
          disk_type: "ssd_io_m3",
          disk_gb: 93,
          storage_mode: "persistent",
        },
      } as any,
      price_display: "monthly",
      pricing_settings: {},
    });

    expect(selection.region).toBe("eu-north1");
    expect(selection.machine_type).toBe("cpu-standard-v3");
    expect(selection.disk_type).toBe("ssd_io_m3");
    expect(selection.disk_gb).toBe(93);
    expect(selection.storage_mode).toBe("persistent");
    expect(selection.price_display).toBe("monthly");
  });

  it("uses the runtime shared scratch type when machine metadata is missing it", () => {
    const selection = buildHostEditSelection({
      host: {
        region: "us-central1",
        funding_mode: "account-postpaid",
        pricing_model: "on_demand",
        machine: {
          machine_type: "4vcpu-16gb",
          disk_type: "ssd_io_m3",
          disk_gb: 93,
          shared_disk_gb: 186,
          storage_mode: "persistent",
        },
        runtime: {
          metadata: {
            scratchDiskTypeCode: 3,
          },
        },
      } as any,
      price_display: "monthly",
      pricing_settings: {},
    });

    expect(selection.shared_disk_gb).toBe(186);
    expect(selection.shared_disk_type).toBe("balanced");
  });

  it("prefers the runtime shared scratch type over stale machine metadata", () => {
    const selection = buildHostEditSelection({
      host: {
        region: "us-central1",
        funding_mode: "account-postpaid",
        pricing_model: "on_demand",
        machine: {
          machine_type: "4vcpu-16gb",
          disk_type: "ssd_io_m3",
          disk_gb: 93,
          shared_disk_gb: 186,
          shared_disk_type: "ssd",
          storage_mode: "persistent",
        },
        runtime: {
          metadata: {
            scratchDiskTypeCode: 3,
          },
        },
      } as any,
      price_display: "monthly",
      pricing_settings: {},
    });

    expect(selection.shared_disk_type).toBe("balanced");
  });
});
