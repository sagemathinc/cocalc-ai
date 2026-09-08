import {
  buildHostSpec,
  getGcpAcceleratorImage,
  getNebiusMinimumBootDiskGb,
} from "./host-util";

const loadGcpImagesMock = jest.fn();
const loadNebiusImagesMock = jest.fn();
const loadNebiusInstanceTypesMock = jest.fn();
const getProviderPrefixMock = jest.fn(async () => "cocalc-host");
const getServerProviderMock = jest.fn(() => undefined);
const getHostSshPublicKeysMock = jest.fn(async () => ["ssh-ed25519 AAAA"]);

jest.mock("./providers", () => ({
  loadNebiusImages: () => loadNebiusImagesMock(),
  loadNebiusInstanceTypes: () => loadNebiusInstanceTypesMock(),
  loadGcpImages: () => loadGcpImagesMock(),
  getServerProvider: () => getServerProviderMock(),
  gcpSafeName: (prefix: string, base: string) => `${prefix}-${base}`,
}));

jest.mock("./provider-context", () => ({
  getProviderContext: jest.fn(),
  getProviderPrefix: () => getProviderPrefixMock(),
}));

jest.mock("./ssh-key", () => ({
  getHostSshPublicKeys: () => getHostSshPublicKeysMock(),
}));

describe("buildHostSpec", () => {
  beforeEach(() => {
    loadGcpImagesMock.mockReset();
    loadNebiusImagesMock.mockReset();
    loadNebiusInstanceTypesMock.mockReset();
    getProviderPrefixMock.mockClear();
    getServerProviderMock.mockClear();
    getHostSshPublicKeysMock.mockClear();
    loadNebiusImagesMock.mockResolvedValue([
      {
        id: "image-1",
        family: "ubuntu24.04-driverless",
        architecture: "X86_64",
        recommended_platforms: ["cpu-d3"],
        region: "eu-north1",
      },
    ]);
  });

  it("defaults new hosts to a 25GB boot disk", async () => {
    const spec = await buildHostSpec({
      id: "832da43c-d18e-406d-8e1d-c28973378b24",
      metadata: {
        machine: {
          metadata: {},
        },
      },
    });

    expect(spec.metadata.boot_disk_gb).toBe(25);
  });

  it("passes runtime shared scratch disk identity into recreate specs", async () => {
    const spec = await buildHostSpec({
      id: "832da43c-d18e-406d-8e1d-c28973378b24",
      region: "eu-north1",
      metadata: {
        runtime: {
          metadata: {
            shared_disk_id: "scratch-disk-id",
            shared_disk_name: "host-scratch",
          },
        },
        machine: {
          cloud: "gcp",
          shared_disk_gb: 500,
          shared_disk_type: "balanced",
          metadata: {},
        },
      },
    });

    expect(spec.metadata.shared_disk_id).toBe("scratch-disk-id");
    expect(spec.metadata.shared_disk_name).toBe("host-scratch");
  });

  it("binds the project-host isolation tag during GCP instance creation", async () => {
    const spec = await buildHostSpec({
      id: "832da43c-d18e-406d-8e1d-c28973378b24",
      region: "us-south1",
      metadata: {
        machine: {
          cloud: "gcp",
          metadata: {},
        },
      },
    });

    expect(spec.tags).toEqual(["cocalc-project-host-isolated"]);
  });

  it("rejects Nebius spot hosts on platforms that disallow preemptibles", async () => {
    loadNebiusInstanceTypesMock.mockResolvedValue([
      {
        name: "cpu-d3-standard-4",
        platform: "cpu-d3",
        platform_label: "CPU D3",
        allowed_for_preemptibles: false,
        vcpus: 4,
        memory_gib: 16,
      },
    ]);

    await expect(
      buildHostSpec({
        id: "832da43c-d18e-406d-8e1d-c28973378b24",
        region: "eu-north1",
        metadata: {
          pricing_model: "spot",
          machine: {
            cloud: "nebius",
            machine_type: "cpu-d3-standard-4",
            metadata: {},
          },
        },
      }),
    ).rejects.toThrow(
      "Nebius spot instances are not supported for machine type cpu-d3-standard-4 (platform cpu-d3). Choose an on-demand host or a Nebius machine type that supports preemptible instances.",
    );
  });

  it("rejects ambiguous Nebius machine names without a platform", async () => {
    loadNebiusInstanceTypesMock.mockResolvedValue([
      {
        name: "1gpu-24vcpu-218gb",
        platform: "gpu-rtx6000",
        regions: ["us-central1"],
        gpus: 1,
      },
      {
        name: "1gpu-24vcpu-218gb",
        platform: "gpu-h200-sxm",
        regions: ["us-central1"],
        gpus: 1,
      },
    ]);

    await expect(
      buildHostSpec({
        id: "832da43c-d18e-406d-8e1d-c28973378b24",
        region: "us-central1",
        metadata: {
          machine: {
            cloud: "nebius",
            machine_type: "1gpu-24vcpu-218gb",
            metadata: {},
          },
        },
      }),
    ).rejects.toThrow(
      "Nebius machine '1gpu-24vcpu-218gb' is ambiguous in us-central1; specify its provider platform",
    );
  });

  it("uses the explicitly selected Nebius platform", async () => {
    loadNebiusInstanceTypesMock.mockResolvedValue([
      {
        name: "1gpu-24vcpu-218gb",
        platform: "gpu-h200-sxm",
        regions: ["us-central1"],
        gpus: 1,
      },
      {
        name: "1gpu-24vcpu-218gb",
        platform: "gpu-rtx6000",
        regions: ["us-central1"],
        gpus: 1,
      },
    ]);
    loadNebiusImagesMock.mockResolvedValue([
      {
        id: "cuda-13",
        family: "ubuntu24.04-cuda13.0",
        architecture: "AMD64",
        recommended_platforms: ["gpu-rtx6000"],
        region: "us-central1",
      },
    ]);

    const spec = await buildHostSpec({
      id: "832da43c-d18e-406d-8e1d-c28973378b24",
      region: "us-central1",
      metadata: {
        machine: {
          cloud: "nebius",
          machine_type: "1gpu-24vcpu-218gb",
          metadata: { platform: "gpu-rtx6000" },
        },
      },
    });

    expect(spec.metadata.platform).toBe("gpu-rtx6000");
    expect(spec.metadata.source_image_family).toBe("ubuntu24.04-cuda13.0");
  });

  it("prefers the newest Nebius CUDA image family for GPU hosts", async () => {
    loadNebiusInstanceTypesMock.mockResolvedValue([
      {
        name: "1gpu-8vcpu-32gb",
        platform: "gpu-l40s-d",
        allowed_for_preemptibles: true,
        gpus: 1,
        vcpus: 8,
        memory_gib: 32,
      },
    ]);
    loadNebiusImagesMock.mockResolvedValue([
      {
        id: "cuda-12",
        family: "ubuntu24.04-cuda12",
        version: "0.2.852",
        architecture: "AMD64",
        recommended_platforms: [],
        region: "eu-north1",
      },
      {
        id: "cuda-13",
        family: "ubuntu24.04-cuda13.0",
        version: "0.2.711",
        architecture: "AMD64",
        recommended_platforms: ["gpu-l40s-d"],
        region: "eu-north1",
      },
      {
        id: "driverless",
        family: "ubuntu24.04-driverless",
        version: "0.2.999",
        architecture: "AMD64",
        recommended_platforms: ["cpu-d3"],
        region: "eu-north1",
      },
    ]);

    const spec = await buildHostSpec({
      id: "832da43c-d18e-406d-8e1d-c28973378b24",
      region: "eu-north1",
      metadata: {
        machine: {
          cloud: "nebius",
          machine_type: "1gpu-8vcpu-32gb",
          metadata: {},
        },
      },
    });

    expect(spec.metadata?.source_image_family).toBe("ubuntu24.04-cuda13.0");
  });

  it("uses the selected Nebius image minimum for GPU boot disks", async () => {
    loadNebiusImagesMock.mockResolvedValue([
      {
        id: "cuda-13",
        family: "ubuntu24.04-cuda13.0",
        version: "0.2.711",
        architecture: "AMD64",
        recommended_platforms: ["gpu-l40s-d"],
        region: "eu-north1",
        minimum_disk_size_gb: 48,
      },
    ]);

    await expect(
      getNebiusMinimumBootDiskGb({
        region: "eu-north1",
        platform: "gpu-l40s-d",
        arch: "x86_64",
        wantsGpu: true,
      }),
    ).resolves.toBe(48);
  });

  it("keeps a 40GB GPU fallback for older Nebius catalog rows", async () => {
    loadNebiusImagesMock.mockResolvedValue([
      {
        id: "cuda-13",
        family: "ubuntu24.04-cuda13.0",
        architecture: "AMD64",
        recommended_platforms: ["gpu-l40s-d"],
        region: "eu-north1",
      },
    ]);

    await expect(
      getNebiusMinimumBootDiskGb({
        region: "eu-north1",
        platform: "gpu-l40s-d",
        arch: "x86_64",
        wantsGpu: true,
      }),
    ).resolves.toBe(40);
  });

  it("filters GCP accelerator images to the machine type architecture", async () => {
    loadGcpImagesMock.mockResolvedValue([
      {
        name: "ubuntu-accelerator-arm-2504",
        family: "ubuntu-accelerator-2504-arm64",
        project: "ubuntu-os-accelerator-images",
        architecture: "ARM64",
        gpuReady: true,
        creationTimestamp: "2026-06-01T00:00:00.000Z",
      },
      {
        name: "ubuntu-accelerator-x86-2404",
        family: "ubuntu-accelerator-2404",
        project: "ubuntu-os-accelerator-images",
        architecture: "X86_64",
        gpuReady: true,
        creationTimestamp: "2026-05-01T00:00:00.000Z",
      },
    ]);

    const spec = await buildHostSpec({
      id: "832da43c-d18e-406d-8e1d-c28973378b24",
      region: "us-central1",
      metadata: {
        gpu: true,
        machine: {
          cloud: "gcp",
          zone: "us-central1-a",
          machine_type: "g2-standard-4",
          gpu_type: "nvidia-l4",
          metadata: {},
        },
      },
    });

    expect(spec.metadata?.source_image_family).toBe("ubuntu-accelerator-2404");
    expect(spec.metadata?.source_image_project).toBe(
      "ubuntu-os-accelerator-images",
    );
  });

  it("can pin managed compute accelerator images to Ubuntu 24.04", async () => {
    loadGcpImagesMock.mockResolvedValue([
      {
        family: "ubuntu-accelerator-2404-amd64-with-nvidia-595",
        project: "ubuntu-os-accelerator-images",
        architecture: "X86_64",
        gpuReady: true,
        creationTimestamp: "2026-07-01T00:00:00.000Z",
      },
      {
        family: "ubuntu-accelerator-2604-amd64-with-nvidia-595",
        project: "ubuntu-os-accelerator-images",
        architecture: "X86_64",
        gpuReady: true,
        creationTimestamp: "2026-08-01T00:00:00.000Z",
      },
    ]);

    await expect(
      getGcpAcceleratorImage("g2-standard-4", { ubuntuVersion: 2404 }),
    ).resolves.toEqual({
      family: "ubuntu-accelerator-2404-amd64-with-nvidia-595",
      project: "ubuntu-os-accelerator-images",
    });
  });
});
