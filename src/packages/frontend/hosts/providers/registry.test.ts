import type { Host, HostCatalog } from "@cocalc/conat/hub/api/hosts";
import {
  buildCreateHostPayload,
  getGcpGpuTypeOptions,
  getHostDisplayedPrice,
  getHostPriceEstimate,
  getGcpMachineTypeOptions,
  getNebiusRegionOptions,
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
      price_display: "monthly",
      storage_mode: "persistent",
      disk_type: "balanced",
      disk_gb: 100,
    });

    expect(options[0].label).toContain("/mo");
    expect(options[0].priceLabel).toContain("/mo");
    expect(options[0].mainLabel).toContain("4 vCPU / 16 GiB");
    expect(options[0].subLabel).toContain("CPU bench 1.00x");
    expect(options[0].subLabel).toContain("Value 1.00x");
    expect(options[0].benchmarkCpuScore).toBeCloseTo(20024.5, 2);
    expect(options[0].benchmarkValueScore).toBeGreaterThan(0);
    expect(options[0].label).toContain("cpu:4");
    expect(options[0].label).toContain("ram:16");
  });

  it("adds benchmark labels for frozen GCP machine families", () => {
    const catalog = testCatalog([
      {
        kind: "machine_types",
        scope: "zone/us-west1-a",
        payload: [
          { name: "e2-standard-4", guestCpus: 4, memoryMb: 16384 },
          { name: "n2d-standard-4", guestCpus: 4, memoryMb: 16384 },
          { name: "c3d-standard-4", guestCpus: 4, memoryMb: 16384 },
        ],
      },
      {
        kind: "prices",
        scope: "global",
        payload: {
          fetched_at: "2026-05-08T00:00:00.000Z",
          service_id: "compute",
          families: {
            e2: {
              cpu: { "us-west1": 0.03 },
              ram: { "us-west1": 0.004 },
              spot_cpu: {},
              spot_ram: {},
            },
            n2d: {
              cpu: { "us-west1": 0.05 },
              ram: { "us-west1": 0.01 },
              spot_cpu: {},
              spot_ram: {},
            },
            c3d: {
              cpu: { "us-west1": 0.055 },
              ram: { "us-west1": 0.008 },
              spot_cpu: {},
              spot_ram: {},
            },
          },
          gpus: {},
          disks: {},
        },
      },
    ]);

    const options = getGcpMachineTypeOptions(catalog, {
      region: "us-west1",
      zone: "us-west1-a",
      pricing_model: "on_demand",
    });

    expect(options.map((opt) => opt.value)).toEqual([
      "c3d-standard-4",
      "e2-standard-4",
      "n2d-standard-4",
    ]);
    expect(options[0].subLabel).toContain("CPU bench 1.18x");
    expect(options[1].subLabel).toContain("CPU bench 0.65x");
    expect(options[2].subLabel).toContain("CPU bench 1.00x");
    expect(options[2].benchmarkCpuScore).toBeGreaterThan(
      options[1].benchmarkCpuScore ?? 0,
    );
  });

  it("shows globally known GCP machine types even when the current zone cannot provision them", () => {
    const catalog = testCatalog([
      {
        kind: "machine_types",
        scope: "zone/us-west1-a",
        payload: [{ name: "n2d-standard-4", guestCpus: 4, memoryMb: 16384 }],
      },
      {
        kind: "machine_types",
        scope: "zone/us-central1-a",
        payload: [{ name: "t2a-standard-4", guestCpus: 4, memoryMb: 16384 }],
      },
      {
        kind: "prices",
        scope: "global",
        payload: {
          fetched_at: "2026-05-08T00:00:00.000Z",
          service_id: "compute",
          families: {
            t2a: {
              cpu: { "us-central1": 0.03 },
              ram: { "us-central1": 0.004 },
              spot_cpu: {},
              spot_ram: {},
            },
            n2d: {
              cpu: { "us-west1": 0.05 },
              ram: { "us-west1": 0.01 },
              spot_cpu: {},
              spot_ram: {},
            },
          },
          gpus: {},
          disks: {},
        },
      },
    ]);

    const options = getGcpMachineTypeOptions(catalog, {
      region: "us-west1",
      zone: "us-west1-a",
      pricing_model: "on_demand",
    });

    expect(options.map((opt) => opt.value)).toEqual([
      "n2d-standard-4",
      "t2a-standard-4",
    ]);
    expect(
      options.find((opt) => opt.value === "t2a-standard-4")?.stateLabel,
    ).toBe("unavailable");
  });

  it("freezes the GCP GPU lane to L4 on G2", () => {
    const catalog = testCatalog([
      {
        kind: "zones",
        scope: "global",
        payload: [{ name: "us-west1-a", region: "us-west1" }],
      },
      {
        kind: "machine_types",
        scope: "zone/us-west1-a",
        payload: [
          { name: "n2d-standard-4", guestCpus: 4, memoryMb: 16384 },
          { name: "g2-standard-4", guestCpus: 4, memoryMb: 16384 },
          { name: "a2-highgpu-1g", guestCpus: 12, memoryMb: 85196 },
        ],
      },
      {
        kind: "gpu_types",
        scope: "zone/us-west1-a",
        payload: [
          { name: "nvidia-l4" },
          { name: "nvidia-tesla-a100" },
          { name: "nvidia-h100-80gb" },
        ],
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
            g2: {
              cpu: { "us-west1": 0.04 },
              ram: { "us-west1": 0.005 },
              spot_cpu: {},
              spot_ram: {},
            },
          },
          gpus: {
            "nvidia-l4": {
              on_demand: { "us-west1": 0.2 },
              spot: {},
            },
          },
          disks: {},
        },
      },
    ]);

    expect(getGcpGpuTypeOptions(catalog).map((opt) => opt.value)).toEqual([
      "nvidia-l4",
    ]);

    expect(
      getGcpMachineTypeOptions(catalog, {
        region: "us-west1",
        zone: "us-west1-a",
        pricing_model: "on_demand",
      }).map((opt) => opt.value),
    ).toEqual(["n2d-standard-4"]);

    expect(
      getGcpMachineTypeOptions(catalog, {
        region: "us-west1",
        zone: "us-west1-a",
        pricing_model: "on_demand",
        gpu_type: "nvidia-l4",
      }).map((opt) => opt.value),
    ).toEqual(["g2-standard-4"]);
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

  it("returns a provider price estimate for GCP standard persistent disks", () => {
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
          fetched_at: "2026-05-09T00:00:00.000Z",
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
      },
    ]);

    const estimate = getProviderPriceEstimate("gcp", catalog, {
      zone: "us-west1-a",
      machine_type: "n2d-standard-4",
      pricing_model: "on_demand",
      storage_mode: "persistent",
      disk_type: "standard",
      disk_gb: 100,
    });

    expect(estimate?.usd_per_hour).toBeCloseTo(0.371, 9);
  });

  it("blends configured surcharges into displayed provider price estimates", () => {
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
          fetched_at: "2026-05-09T00:00:00.000Z",
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
      },
    ]);

    const estimate = getProviderPriceEstimate(
      "gcp",
      catalog,
      {
        zone: "us-west1-a",
        machine_type: "n2d-standard-4",
        pricing_model: "on_demand",
        storage_mode: "persistent",
        disk_type: "standard",
        disk_gb: 100,
      },
      {
        project_hosts_gcp_surcharge_percent: 20,
      },
    );

    expect(estimate?.usd_per_hour).toBeCloseTo(0.4452, 9);
    expect(estimate?.notes).toContain("Includes a 20% site surcharge.");
    expect(
      estimate?.line_items.reduce((sum, item) => sum + item.usd_per_hour, 0),
    ).toBeCloseTo(0.4452, 9);
  });

  it("uses a self-hosted provider charge note for site-funded hosts", () => {
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
          fetched_at: "2026-05-09T00:00:00.000Z",
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
      },
    ]);

    const estimate = getProviderPriceEstimate("gcp", catalog, {
      zone: "us-west1-a",
      machine_type: "n2d-standard-4",
      funding_mode: "site-funded",
      pricing_model: "on_demand",
      storage_mode: "persistent",
      disk_type: "standard",
      disk_gb: 100,
    });

    expect(estimate?.notes).toContain(
      "Provider network egress and similar cloud charges are billed directly by your cloud provider and are not included in this estimate.",
    );
  });

  it("uses a CoCalc-covered network note for account-funded hosts", () => {
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
          fetched_at: "2026-05-09T00:00:00.000Z",
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
      },
    ]);

    const estimate = getProviderPriceEstimate("gcp", catalog, {
      zone: "us-west1-a",
      machine_type: "n2d-standard-4",
      funding_mode: "account-postpaid",
      pricing_model: "on_demand",
      storage_mode: "persistent",
      disk_type: "standard",
      disk_gb: 100,
    });

    expect(estimate?.notes).toContain(
      "There is no additional CoCalc charge to end users for network egress; any provider egress cost is covered by the site's subscription and cloud billing arrangement.",
    );
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

  it("labels missing Nebius regional prices explicitly once a machine is selected", () => {
    const catalog = testCatalog([
      {
        kind: "regions",
        scope: "global",
        payload: [{ name: "eu-north1" }, { name: "us-central1" }],
      },
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
        ],
      },
    ]);

    const options = getNebiusRegionOptions(catalog, {
      machine_type: "gpu-h100-80gb-1",
      pricing_model: "spot",
    });

    expect(
      options.find((opt) => opt.value === "eu-north1")?.priceLabel,
    ).toContain("/hr");
    expect(options.find((opt) => opt.value === "us-central1")?.stateLabel).toBe(
      "price unavailable",
    );
  });

  it("prices Nebius hosts from the Nebius catalog even when the page also has a GCP catalog", () => {
    const gcpCatalog = testCatalog([
      {
        kind: "prices",
        scope: "global",
        payload: {
          fetched_at: "2026-05-09T00:00:00.000Z",
          service_id: "compute",
          families: {},
          gpus: {},
          disks: {},
        },
      },
    ]);
    const nebiusCatalog = testCatalog([
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

    const host = {
      id: "host-nebius",
      name: "Nebius Host",
      owner: "acct",
      region: "eu-north1",
      size: "cpu-standard-v3",
      gpu: false,
      status: "running",
      machine: {
        cloud: "nebius",
        machine_type: "cpu-standard-v3",
        storage_mode: "persistent",
        disk_type: "ssd_io_m3",
        disk_gb: 93,
      },
      pricing_model: "on_demand",
    } as Host;

    const estimate = getHostPriceEstimate(host, {
      gcp: gcpCatalog,
      nebius: nebiusCatalog,
    });

    expect(estimate?.usd_per_hour).toBeCloseTo(0.114183323, 9);
  });

  it("shows disk-only current pricing for stopped hosts and full pricing if started", () => {
    const gcpCatalog = testCatalog([
      {
        kind: "machine_types",
        scope: "zone/us-west1-a",
        payload: [{ name: "n2d-standard-4", guestCpus: 4, memoryMb: 16384 }],
      },
      {
        kind: "prices",
        scope: "global",
        payload: {
          fetched_at: "2026-05-09T00:00:00.000Z",
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
      },
    ]);

    const host = {
      id: "host-off",
      name: "Stopped GCP Host",
      owner: "acct",
      region: "us-west1",
      size: "n2d-standard-4",
      gpu: false,
      status: "off",
      machine: {
        cloud: "gcp",
        zone: "us-west1-a",
        machine_type: "n2d-standard-4",
        storage_mode: "persistent",
        disk_type: "standard",
        disk_gb: 100,
      },
      pricing_model: "on_demand",
    } as Host;

    const display = getHostDisplayedPrice(host, { gcp: gcpCatalog });

    expect(display?.current_state).toBe("stopped");
    expect(display?.current_estimate?.usd_per_hour).toBeCloseTo(0.006, 9);
    expect(display?.running_estimate?.usd_per_hour).toBeCloseTo(0.371, 9);
  });

  it("shows zero current pricing for deprovisioned hosts and preserves the reprovision estimate", () => {
    const gcpCatalog = testCatalog([
      {
        kind: "machine_types",
        scope: "zone/us-west1-a",
        payload: [{ name: "n2d-standard-4", guestCpus: 4, memoryMb: 16384 }],
      },
      {
        kind: "prices",
        scope: "global",
        payload: {
          fetched_at: "2026-05-09T00:00:00.000Z",
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
      },
    ]);

    const host = {
      id: "host-deprov",
      name: "Deprovisioned GCP Host",
      owner: "acct",
      region: "us-west1",
      size: "n2d-standard-4",
      gpu: false,
      status: "deprovisioned",
      machine: {
        cloud: "gcp",
        zone: "us-west1-a",
        machine_type: "n2d-standard-4",
        storage_mode: "persistent",
        disk_type: "standard",
        disk_gb: 100,
      },
      pricing_model: "on_demand",
    } as Host;

    const display = getHostDisplayedPrice(host, { gcp: gcpCatalog });

    expect(display?.current_state).toBe("deprovisioned");
    expect(display?.current_estimate?.usd_per_hour).toBe(0);
    expect(display?.running_estimate?.usd_per_hour).toBeCloseTo(0.371, 9);
  });
});
