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
});
