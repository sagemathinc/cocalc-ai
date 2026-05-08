import type { HostCatalog } from "@cocalc/conat/hub/api/hosts";
import {
  buildCreateHostPayload,
  getGcpMachineTypeOptions,
  getProviderPriceEstimate,
  isNebiusSpotSupported,
} from "./registry";

function testCatalog(entries: HostCatalog["entries"]): HostCatalog {
  return {
    entries,
    provider_capabilities: {},
  };
}

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
        funding_mode: "account-postpaid",
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
    expect(payload.funding_mode).toBe("account-postpaid");
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

describe("catalog-backed pricing labels", () => {
  it("shows GCP machine type pricing in option labels", () => {
    const catalog = testCatalog([
      {
        kind: "machine_types",
        scope: "zone/us-west1-a",
        payload: [{ name: "n2d-standard-4", guestCpus: 4, memoryMb: 16384 }],
      },
      {
        kind: "prices",
        scope: "global",
        payload: {
          fetched_at: "2026-05-08T00:00:00.000Z",
          service_id: "compute",
          families: {
            n2d: {
              cpu: { "us-west1": 0.05 },
              ram: { "us-west1": 0.01 },
              spot_cpu: {},
              spot_ram: {},
            },
          },
          gpus: {},
          disks: {
            "pd-balanced": { "us-west1": 0.0001 },
          },
        },
      },
    ]);

    const options = getGcpMachineTypeOptions(catalog, {
      region: "us-west1",
      zone: "us-west1-a",
      machine_type: "n2d-standard-4",
      pricing_model: "on_demand",
      storage_mode: "persistent",
      disk_type: "balanced",
      disk_gb: 100,
    });

    expect(options[0].label).toContain("/hr");
  });

  it("returns a provider price estimate for Nebius selections", () => {
    const catalog = testCatalog([
      {
        kind: "instance_types",
        scope: "global",
        payload: [
          {
            name: "cpu-standard-v3",
            platform: "amd-epyc-genoa",
            platform_label: "AMD Epyc Genoa",
            vcpus: 4,
            memory_gib: 16,
            gpus: 0,
          },
        ],
      },
      {
        kind: "prices",
        scope: "global",
        payload: [
          {
            product: "Non-GPU AMD Epyc Genoa. CPU",
            region: "eu-north1",
            price_usd: "0.012",
            unit: "vCPU hour",
          },
          {
            product: "Non-GPU AMD Epyc Genoa. RAM",
            region: "eu-north1",
            price_usd: "0.0032",
            unit: "GiB hour",
          },
          {
            product: "Network SSD IO M3 disk",
            region: "eu-north1",
            price_usd: "0.000161111",
            unit: "GiB hour",
          },
        ],
      },
    ]);

    const estimate = getProviderPriceEstimate("nebius", catalog, {
      region: "eu-north1",
      machine_type: "cpu-standard-v3",
      pricing_model: "on_demand",
      storage_mode: "persistent",
      disk_type: "ssd_io_m3",
      disk_gb: 93,
    });

    expect(estimate?.usd_per_hour).toBeCloseTo(0.114183323, 9);
    expect(estimate?.hourly_label).toContain("/hr");
    expect(estimate?.monthly_label).toContain("/mo");
  });

  it("returns a provider price estimate for Nebius spot GPU selections", () => {
    const catalog = testCatalog([
      {
        kind: "instance_types",
        scope: "global",
        payload: [
          {
            name: "gpu-h100-80gb-1",
            platform: "gpu-h100-sxm",
            platform_label: "H100 NVLink",
            vcpus: 16,
            memory_gib: 200,
            gpus: 1,
            gpu_label: "NVIDIA H100",
          },
        ],
      },
      {
        kind: "prices",
        scope: "global",
        payload: [
          {
            product:
              "Preemptible NVIDIA® H100 NVLink with Intel Sapphire Rapids. CPU",
            region: "eu-north1",
            price_usd: "0.018",
            unit: "vCPU hour",
          },
          {
            product:
              "Preemptible NVIDIA® H100 NVLink with Intel Sapphire Rapids. RAM",
            region: "eu-north1",
            price_usd: "0.0045",
            unit: "GiB hour",
          },
          {
            product:
              "Preemptible NVIDIA® H100 NVLink with Intel Sapphire Rapids. GPU",
            region: "eu-north1",
            price_usd: "0.834",
            unit: "GPU hour",
          },
          {
            product: "Network SSD IO M3 disk",
            region: "eu-north1",
            price_usd: "0.000161111",
            unit: "GiB hour",
          },
        ],
      },
    ]);

    const estimate = getProviderPriceEstimate("nebius", catalog, {
      region: "eu-north1",
      machine_type: "gpu-h100-80gb-1",
      pricing_model: "spot",
      storage_mode: "persistent",
      disk_type: "ssd_io_m3",
      disk_gb: 93,
    });

    expect(estimate?.usd_per_hour).toBeCloseTo(2.036983323, 9);
    expect(estimate?.hourly_label).toContain("/hr");
  });
});
