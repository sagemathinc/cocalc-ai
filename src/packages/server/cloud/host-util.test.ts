import { buildHostSpec } from "./host-util";

const loadNebiusImagesMock = jest.fn();
const loadNebiusInstanceTypesMock = jest.fn();
const getProviderPrefixMock = jest.fn(async () => "cocalc-host");
const getServerProviderMock = jest.fn(() => undefined);
const getHostSshPublicKeysMock = jest.fn(async () => ["ssh-ed25519 AAAA"]);

jest.mock("./providers", () => ({
  loadNebiusImages: () => loadNebiusImagesMock(),
  loadNebiusInstanceTypes: () => loadNebiusInstanceTypesMock(),
  loadGcpImages: jest.fn(),
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
});
