import { fetchNebiusCatalog } from "../catalog/nebius";

const platformsListMock = jest.fn();
const imagesListMock = jest.fn();
const imagesListPublicMock = jest.fn();
const mockFetchNebiusPricingFromDocs = jest.fn();
const clientDisposeMock = jest.fn();

jest.mock("../nebius/client", () => {
  class NebiusClient {
    readonly platforms = { list: platformsListMock };
    readonly images = {
      list: imagesListMock,
      listPublic: imagesListPublicMock,
    };

    constructor(private creds: any) {}

    async [Symbol.asyncDispose]() {
      await clientDisposeMock();
    }

    parentId() {
      return this.creds.parentId;
    }
  }

  return { NebiusClient };
});

jest.mock("../catalog/nebius-pricing", () => ({
  fetchNebiusPricingFromDocs: (...args: unknown[]) =>
    mockFetchNebiusPricingFromDocs(...args),
}));

const image = (id: string, recommendedPlatforms: string[]) => ({
  metadata: {
    id,
    name: `${id}.img`,
    createdAt: { toISOString: () => "2026-05-24T00:00:00.000Z" },
  },
  spec: {
    imageFamily: "ubuntu24.04-cuda13.0",
    version: "1",
    cpuArchitecture: { name: "AMD64" },
    recommendedPlatforms,
  },
  status: {
    minDiskSizeBytes: 40 * 2 ** 30,
  },
});

describe("Nebius catalog", () => {
  beforeEach(() => {
    clientDisposeMock.mockReset();
    platformsListMock.mockReset();
    imagesListMock.mockReset();
    imagesListPublicMock.mockReset();
    mockFetchNebiusPricingFromDocs.mockReset();
  });

  afterEach(() => {
    expect(clientDisposeMock).toHaveBeenCalledTimes(1);
  });

  it("closes the client when fetching the catalog fails", async () => {
    platformsListMock.mockRejectedValue(new Error("catalog unavailable"));
    imagesListMock.mockResolvedValue({ items: [], nextPageToken: "" });
    await expect(
      fetchNebiusCatalog({
        parentId: "project-1",
        serviceAccountId: "svc-1",
        publicKeyId: "pub-1",
        privateKeyPem: "key",
      }),
    ).rejects.toThrow("catalog unavailable");
  });

  it("adds documented B200 and RTX GPU presets when prices and images exist", async () => {
    platformsListMock.mockResolvedValue({ items: [], nextPageToken: "" });
    imagesListPublicMock.mockResolvedValue({
      items: [image("cuda-us", ["gpu-b200-sxm", "gpu-rtx6000"])],
      nextPageToken: "",
    });
    mockFetchNebiusPricingFromDocs.mockResolvedValue([
      {
        service: "Compute",
        product: "NVIDIA® B200 NVLink. GPU",
        region: "us-central1",
        price_usd: "4.5432",
        unit: "GPU hour",
        valid_from: "2026-05-24",
      },
      {
        service: "Compute",
        product: "NVIDIA® B200 NVLink. CPU",
        region: "us-central1",
        price_usd: "0.012",
        unit: "vCPU hour",
        valid_from: "2026-05-24",
      },
      {
        service: "Compute",
        product: "NVIDIA® B200 NVLink. RAM",
        region: "us-central1",
        price_usd: "0.0032",
        unit: "GiB hour",
        valid_from: "2026-05-24",
      },
      {
        service: "Compute",
        product: "NVIDIA® RTX PRO™ 6000",
        region: "us-central1",
        price_usd: "1.80",
        unit: "GPU hour",
        valid_from: "2026-05-24",
      },
    ]);

    const catalog = await fetchNebiusCatalog({
      serviceAccountId: "svc",
      publicKeyId: "pub",
      privateKeyPem: "key",
      parentId: "parent",
      regions: ["us-central1"],
    });

    expect(catalog.instance_types).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "1gpu-20vcpu-224gb",
          platform: "gpu-b200-sxm",
          regions: ["us-central1"],
          gpus: 1,
          vcpus: 20,
          memory_gib: 224,
        }),
        expect.objectContaining({
          name: "8gpu-160vcpu-1792gb",
          platform: "gpu-b200-sxm",
          regions: ["us-central1"],
          gpus: 8,
        }),
        expect.objectContaining({
          name: "1gpu-24vcpu-218gb",
          platform: "gpu-rtx6000",
          regions: ["us-central1"],
          gpus: 1,
        }),
      ]),
    );
    expect(catalog.images[0]?.minimum_disk_size_gb).toBe(40);
  });

  it("adds documented B300 presets for a configured uk-south1 project", async () => {
    platformsListMock.mockResolvedValue({ items: [], nextPageToken: "" });
    imagesListPublicMock.mockResolvedValue({
      items: [image("cuda-uk", ["gpu-b300-sxm"])],
      nextPageToken: "",
    });
    mockFetchNebiusPricingFromDocs.mockResolvedValue([
      {
        service: "Compute",
        product: "Preemptible NVIDIA B300 NVLink",
        region: "uk-south1",
        price_usd: "3.40",
        unit: "GPU hour",
        valid_from: "2026-08-21",
      },
    ]);

    const catalog = await fetchNebiusCatalog({
      serviceAccountId: "svc",
      publicKeyId: "pub",
      privateKeyPem: "key",
      parentId: "parent",
      regions: ["uk-south1"],
    });

    expect(catalog.regions).toEqual(["uk-south1"]);
    expect(catalog.instance_types).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "1gpu-24vcpu-346gb",
          platform: "gpu-b300-sxm",
          regions: ["uk-south1"],
          gpus: 1,
          vcpus: 24,
          memory_gib: 346,
        }),
        expect.objectContaining({
          name: "8gpu-192vcpu-2768gb",
          platform: "gpu-b300-sxm",
          regions: ["uk-south1"],
          gpus: 8,
        }),
      ]),
    );
  });
});
