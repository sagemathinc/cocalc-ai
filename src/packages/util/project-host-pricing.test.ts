import {
  estimateGcpCatalogRateUsdPerHour,
  estimateNebiusCatalogRateUsdPerHour,
  type GcpCatalogPrices,
} from "./project-host-pricing";

describe("project host pricing", () => {
  it("estimates GCP hourly rates from normalized catalog pricing", () => {
    const catalog: GcpCatalogPrices = {
      fetched_at: "2026-05-08T00:00:00.000Z",
      service_id: "compute",
      families: {
        n2d: {
          cpu: { "us-west1": 0.05 },
          ram: { "us-west1": 0.01 },
          spot_cpu: { "us-west1": 0.02 },
          spot_ram: { "us-west1": 0.003 },
        },
      },
      gpus: {},
      disks: {
        "pd-balanced": { "us-west1": 0.0001 },
      },
    };

    expect(
      estimateGcpCatalogRateUsdPerHour(catalog, {
        zone: "us-west1-a",
        machine_type: "n2d-standard-4",
        pricing_model: "spot",
        disk_type: "balanced",
        disk_gb: 100,
        storage_mode: "persistent",
      }),
    ).toBeCloseTo(0.138, 9);
  });

  it("estimates Nebius hourly rates from normalized catalog pricing", () => {
    expect(
      estimateNebiusCatalogRateUsdPerHour({
        prices: [
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
        region: "eu-north1",
        pricing_model: "on_demand",
        instance: {
          name: "cpu-standard-v3",
          platform: "amd-epyc-genoa",
          platform_label: "AMD Epyc Genoa",
          vcpus: 4,
          memory_gib: 16,
          gpus: 0,
        },
        disk_type: "ssd_io_m3",
        disk_gb: 93,
        storage_mode: "persistent",
      }),
    ).toBeCloseTo(0.114183323, 9);
  });

  it("estimates Nebius spot GPU hourly rates from preemptible catalog rows", () => {
    expect(
      estimateNebiusCatalogRateUsdPerHour({
        prices: [
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
        region: "eu-north1",
        pricing_model: "spot",
        instance: {
          name: "gpu-h100-80gb-1",
          platform: "gpu-h100-sxm",
          platform_label: "H100 NVLink",
          vcpus: 16,
          memory_gib: 200,
          gpus: 1,
          gpu_label: "NVIDIA H100",
        },
        disk_type: "ssd_io_m3",
        disk_gb: 93,
        storage_mode: "persistent",
      }),
    ).toBeCloseTo(2.036983323, 9);
  });
});
