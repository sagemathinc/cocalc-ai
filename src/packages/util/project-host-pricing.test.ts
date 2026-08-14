import {
  applyDedicatedHostSurchargeToBreakdown,
  estimateGcpCatalogPersistentDiskRateBreakdown,
  estimateGcpCatalogRateBreakdown,
  estimateGcpCatalogRateUsdPerHour,
  estimateNebiusCatalogRateBreakdown,
  estimateNebiusCatalogRateUsdPerHour,
  getDedicatedHostSurchargeFraction,
  gcpMachineArchitecture,
  gcpMachineGpu,
  gcpMinimumBootDiskGb,
  hostPriceBreakdownForBillingState,
  isSupportedCatalogGcpMachineType,
  type GcpCatalogPrices,
} from "./project-host-pricing";

describe("project host pricing", () => {
  it("describes the fixed L4 topology of G2 machine types", () => {
    expect(gcpMachineGpu("g2-standard-4")).toEqual({
      type: "nvidia-l4",
      count: 1,
    });
    expect(gcpMachineGpu("g2-standard-24")?.count).toBe(2);
    expect(gcpMachineGpu("g2-standard-48")?.count).toBe(4);
    expect(gcpMachineGpu("g2-standard-96")?.count).toBe(8);
    expect(gcpMachineGpu("t2d-standard-4")).toBeUndefined();
    expect(gcpMinimumBootDiskGb("g2-standard-4")).toBe(40);
    expect(gcpMinimumBootDiskGb("t2d-standard-4")).toBe(10);
  });

  it("selects stopped costs from explicit billing-state metadata", () => {
    const stopped = hostPriceBreakdownForBillingState(
      {
        items: [
          {
            key: "vm",
            label: "Retained provider reservation",
            usd_per_hour: 2,
            billing_states: ["running", "stopped"],
          },
          {
            key: "disk",
            label: "Ephemeral disk",
            usd_per_hour: 1,
            billing_states: ["running"],
          },
        ],
        total_usd_per_hour: 3,
      },
      "stopped",
    );

    expect(stopped).toEqual({
      items: [
        {
          key: "vm",
          label: "Retained provider reservation",
          usd_per_hour: 2,
          billing_states: ["running", "stopped"],
        },
      ],
      total_usd_per_hour: 2,
    });
  });

  it("filters out local-SSD GCP machine variants from the frozen catalog", () => {
    expect(isSupportedCatalogGcpMachineType("c3d-standard-8")).toBe(true);
    expect(isSupportedCatalogGcpMachineType("c3d-standard-8-lssd")).toBe(false);
  });

  it("uses the explicit machine-family architecture map", () => {
    expect(gcpMachineArchitecture("t2a-standard-1")).toBe("arm64");
    expect(gcpMachineArchitecture("t2d-standard-2")).toBe("x86_64");
    expect(gcpMachineArchitecture("c3d-standard-8")).toBe("x86_64");
  });

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

  it("estimates a persistent GCP disk without VM pricing", () => {
    const catalog: GcpCatalogPrices = {
      fetched_at: "2026-08-07T00:00:00.000Z",
      service_id: "compute",
      families: {},
      gpus: {},
      disks: {
        "pd-balanced": { "us-west1": 0.0001 },
      },
    };

    expect(
      estimateGcpCatalogPersistentDiskRateBreakdown(catalog, {
        zone: "us-west1-a",
        disk_type: "balanced",
        disk_gb: 50,
        storage_mode: "persistent",
      }),
    ).toEqual({
      items: [
        {
          key: "disk",
          label: "Persistent disk",
          usd_per_hour: 0.005,
          billing_states: ["running", "stopped"],
        },
      ],
      total_usd_per_hour: 0.005,
    });
  });

  it("adds GCP shared scratch disk as a separate line item", () => {
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
        "pd-ssd": { "us-west1": 0.0002 },
      },
    };

    const breakdown = estimateGcpCatalogRateBreakdown(catalog, {
      zone: "us-west1-a",
      machine_type: "n2d-standard-4",
      disk_type: "balanced",
      disk_gb: 100,
      shared_disk_type: "ssd",
      shared_disk_gb: 500,
      storage_mode: "persistent",
    });

    expect(breakdown?.items.map((item) => item.key)).toEqual([
      "vm",
      "disk",
      "shared_scratch_disk",
      "public_ipv4",
    ]);
    expect(
      breakdown?.items.find((item) => item.key === "shared_scratch_disk")
        ?.usd_per_hour,
    ).toBeCloseTo(0.1, 9);
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

  it("supports E2 general-purpose pricing", () => {
    const catalog: GcpCatalogPrices = {
      fetched_at: "2026-05-08T00:00:00.000Z",
      service_id: "compute",
      families: {
        e2: {
          cpu: { "us-west1": 0.021 },
          ram: { "us-west1": 0.0028 },
          spot_cpu: { "us-west1": 0.0084 },
          spot_ram: { "us-west1": 0.00112 },
        },
      },
      gpus: {},
      disks: {},
    };

    expect(
      estimateGcpCatalogRateUsdPerHour(catalog, {
        zone: "us-west1-b",
        machine_type: "e2-standard-4",
        pricing_model: "on_demand",
      }),
    ).toBeCloseTo(0.1338, 9);
  });

  it("supports G2 pricing with L4 GPUs", () => {
    const catalog: GcpCatalogPrices = {
      fetched_at: "2026-05-08T00:00:00.000Z",
      service_id: "compute",
      families: {
        g2: {
          cpu: { "us-west1": 0.04 },
          ram: { "us-west1": 0.005 },
          spot_cpu: { "us-west1": 0.016 },
          spot_ram: { "us-west1": 0.002 },
        },
      },
      gpus: {
        "nvidia-l4": {
          on_demand: { "us-west1": 0.2 },
          spot: { "us-west1": 0.08 },
        },
      },
      disks: {},
    };

    expect(
      estimateGcpCatalogRateUsdPerHour(catalog, {
        zone: "us-west1-a",
        machine_type: "g2-standard-4",
        pricing_model: "on_demand",
        gpu_type: "nvidia-l4",
        gpu_count: 1,
      }),
    ).toBeCloseTo(0.445, 9);
  });

  it("supports N2 highmem pricing", () => {
    const catalog: GcpCatalogPrices = {
      fetched_at: "2026-05-08T00:00:00.000Z",
      service_id: "compute",
      families: {
        n2: {
          cpu: { "us-west1": 0.052 },
          ram: { "us-west1": 0.007 },
          spot_cpu: { "us-west1": 0.0208 },
          spot_ram: { "us-west1": 0.0028 },
        },
      },
      gpus: {},
      disks: {},
    };

    expect(
      estimateGcpCatalogRateUsdPerHour(catalog, {
        zone: "us-west1-a",
        machine_type: "n2-highmem-8",
        pricing_model: "on_demand",
      }),
    ).toBeCloseTo(0.869, 9);
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

  it("charges the Windows Server license at the same rate for Spot", () => {
    const catalog: GcpCatalogPrices = {
      fetched_at: "2026-08-13T00:00:00.000Z",
      service_id: "compute",
      families: {
        e2: {
          cpu: { "us-central1": 0.03 },
          ram: { "us-central1": 0.004 },
          spot_cpu: { "us-central1": 0.01 },
          spot_ram: { "us-central1": 0.001 },
        },
      },
      gpus: {},
      disks: { "pd-balanced": { "us-central1": 0.0001 } },
    };
    const windows = estimateGcpCatalogRateBreakdown(catalog, {
      zone: "us-central1-a",
      machine_type: "e2-standard-4",
      pricing_model: "spot",
      disk_type: "balanced",
      disk_gb: 80,
      operating_system: "windows",
    });
    const license = windows?.items.find(({ key }) => key === "windows_license");

    expect(license?.usd_per_hour).toBeCloseTo(4 * 0.046, 9);
    expect(license?.billing_states).toEqual(["running"]);
    expect(
      hostPriceBreakdownForBillingState(windows, "stopped")?.items.some(
        ({ key }) => key === "windows_license",
      ),
    ).toBe(false);
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

  it("prices an independent Nebius persistent disk without an instance", () => {
    const breakdown = estimateNebiusCatalogRateBreakdown({
      prices: [
        {
          product: "Network SSD disk",
          region: "us-central1",
          price_usd: "0.00009726027397260273",
          unit: "GiB hour",
        },
      ],
      region: "us-central1",
      disk_type: "ssd",
      disk_gb: 93,
      storage_mode: "persistent",
    });

    expect(breakdown?.items).toEqual([
      expect.objectContaining({
        key: "disk",
        billing_states: ["running", "stopped"],
      }),
    ]);
    expect(breakdown?.total_usd_per_hour).toBeCloseTo(
      0.00009726027397260273 * 93,
      12,
    );
  });

  it("adds Nebius shared scratch disk as a separate line item", () => {
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
          product: "Network SSD disk",
          region: "eu-north1",
          price_usd: "0.0001",
          unit: "GiB hour",
        },
        {
          product: "Network SSD Non-replicated disk",
          region: "eu-north1",
          price_usd: "0.00005",
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
      disk_type: "ssd",
      disk_gb: 100,
      shared_disk_type: "balanced",
      shared_disk_gb: 1000,
      storage_mode: "persistent",
    });

    expect(breakdown?.items.map((item) => item.key)).toEqual([
      "vm",
      "disk",
      "shared_scratch_disk",
    ]);
    expect(
      breakdown?.items.find((item) => item.key === "shared_scratch_disk")
        ?.usd_per_hour,
    ).toBeCloseTo(0.05, 9);
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

  it("estimates Nebius unified GPU hourly rates without separate CPU/RAM rows", () => {
    const breakdown = estimateNebiusCatalogRateBreakdown({
      prices: [
        {
          product: "NVIDIA RTX PRO 6000",
          region: "us-central1",
          price_usd: "1.8",
          unit: "GPU hour",
        },
        {
          product: "Network SSD IO M3 disk",
          region: "us-central1",
          price_usd: "0.000161111",
          unit: "GiB hour",
        },
      ],
      region: "us-central1",
      pricing_model: "on_demand",
      instance: {
        name: "gpu-rtx6000_1gpu-24vcpu-218gb",
        platform: "gpu-rtx6000",
        platform_label: "NVIDIA RTX PRO 6000",
        vcpus: 24,
        memory_gib: 218,
        gpus: 1,
        gpu_label: "NVIDIA RTX PRO 6000",
      },
      disk_type: "ssd_io_m3",
      disk_gb: 100,
      storage_mode: "persistent",
    });

    expect(breakdown?.items.map((item) => item.key)).toEqual(["gpu", "disk"]);
    expect(breakdown?.items[0]?.label).toBe("GPU instance");
    expect(breakdown?.total_usd_per_hour).toBeCloseTo(1.8161111, 9);
  });
});
