import { fetchNebiusCatalog } from "../catalog/nebius";

const platformsListMock = jest.fn();
const imagesListMock = jest.fn();
const imagesListPublicMock = jest.fn();
const mockFetchNebiusPricingFromDocs = jest.fn();

jest.mock("../nebius/client", () => {
  class NebiusClient {
    readonly platforms = { list: platformsListMock };
    readonly images = {
      list: imagesListMock,
      listPublic: imagesListPublicMock,
    };

    constructor(private creds: any) {}

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
});

describe("Nebius catalog", () => {
  beforeEach(() => {
    platformsListMock.mockReset();
    imagesListMock.mockReset();
    imagesListPublicMock.mockReset();
    mockFetchNebiusPricingFromDocs.mockReset();
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
  });
});
