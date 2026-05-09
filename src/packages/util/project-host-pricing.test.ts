import {
  applyDedicatedHostSurchargeToBreakdown,
  estimateGcpCatalogRateBreakdown,
  estimateGcpCatalogRateUsdPerHour,
  estimateNebiusCatalogRateBreakdown,
  estimateNebiusCatalogRateUsdPerHour,
  getDedicatedHostSurchargeFraction,
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
    ).toBeCloseTo(0.1405, 9);
  });

  it("supports T2A ARM machine pricing", () => {
    const catalog: GcpCatalogPrices = {
      fetched_at: "2026-05-08T00:00:00.000Z",
      service_id: "compute",
      families: {
        t2a: {
          cpu: { "us-west1": 0.03 },
          ram: { "us-west1": 0.004 },
          spot_cpu: { "us-west1": 0.012 },
          spot_ram: { "us-west1": 0.0016 },
        },
      },
      gpus: {},
      disks: {},
    };

    expect(
      estimateGcpCatalogRateUsdPerHour(catalog, {
        zone: "us-west1-a",
        machine_type: "t2a-standard-4",
        pricing_model: "on_demand",
      }),
    ).toBeCloseTo(0.189, 9);
  });

  it("supports C3D pricing with explicit machine metadata overrides", () => {
    const catalog: GcpCatalogPrices = {
      fetched_at: "2026-05-08T00:00:00.000Z",
      service_id: "compute",
      families: {
        c3d: {
          cpu: { "us-west1": 0.04 },
          ram: { "us-west1": 0.005 },
          spot_cpu: { "us-west1": 0.016 },
          spot_ram: { "us-west1": 0.002 },
        },
      },
      gpus: {},
      disks: {},
    };

    expect(
      estimateGcpCatalogRateUsdPerHour(catalog, {
        zone: "us-west1-a",
        machine_type: "c3d-highcpu-30",
        cpu_count: 30,
        memory_gib: 59,
        pricing_model: "on_demand",
      }),
    ).toBeCloseTo(1.5, 9);
  });

  it("returns a GCP breakdown that includes disk and public IPv4", () => {
    const catalog: GcpCatalogPrices = {
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
        "pd-standard": { "us-west1": 0.00006 },
      },
    };

    const breakdown = estimateGcpCatalogRateBreakdown(catalog, {
      zone: "us-west1-a",
      machine_type: "n2d-standard-4",
      pricing_model: "on_demand",
      disk_type: "standard",
      disk_gb: 100,
      storage_mode: "persistent",
    });

    expect(breakdown?.items.map((item) => item.key)).toEqual([
      "vm",
      "disk",
      "public_ipv4",
    ]);
    expect(
      breakdown?.items.find((item) => item.key === "public_ipv4")?.usd_per_hour,
    ).toBeCloseTo(0.005, 9);
    expect(breakdown?.total_usd_per_hour).toBeCloseTo(0.371, 9);
  });

  it("applies configured surcharges proportionally across displayed breakdown items", () => {
    const base = estimateGcpCatalogRateBreakdown(
      {
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
          "pd-standard": { "us-west1": 0.00006 },
        },
      },
      {
        zone: "us-west1-a",
        machine_type: "n2d-standard-4",
        pricing_model: "on_demand",
        disk_type: "standard",
        disk_gb: 100,
        storage_mode: "persistent",
      },
    );
    const fraction = getDedicatedHostSurchargeFraction("gcp", {
      project_hosts_gcp_surcharge_percent: 20,
    });
    const surcharged = applyDedicatedHostSurchargeToBreakdown(base, fraction);

    expect(fraction).toBeCloseTo(0.2, 9);
    expect(surcharged?.total_usd_per_hour).toBeCloseTo(0.4452, 9);
    expect(
      surcharged?.items.reduce((sum, item) => sum + item.usd_per_hour, 0),
    ).toBeCloseTo(0.4452, 9);
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

  it("returns a Nebius breakdown with vm and disk line items", () => {
    const breakdown = estimateNebiusCatalogRateBreakdown({
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
    });

    expect(breakdown?.items.map((item) => item.key)).toEqual(["vm", "disk"]);
    expect(breakdown?.total_usd_per_hour).toBeCloseTo(0.114183323, 9);
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
