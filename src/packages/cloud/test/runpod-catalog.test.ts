import { normalizeRunpodCatalog } from "../runpod/catalog";

const now = new Date("2026-10-27T05:00:00.000Z");

describe("normalizeRunpodCatalog", () => {
  const gpuTypes = [
    {
      id: "NVIDIA H100 80GB HBM3",
      displayName: "H100 SXM",
      memoryInGb: 80,
      secureCloud: true,
      communityCloud: true,
      securePrice: 3.99,
      communityPrice: 2.69,
      lowestPrice: { stockStatus: "Medium" },
    },
    {
      id: "NVIDIA RTX A5000",
      displayName: "RTX A5000",
      memoryInGb: 24,
      secureCloud: true,
      communityCloud: true,
      securePrice: 0.27,
      communityPrice: 0.16,
      lowestPrice: { stockStatus: "Low" },
    },
    {
      // RunPod reports 0 for a cloud type it doesn't offer
      id: "NVIDIA A100-SXM4-40GB",
      displayName: "A100 SXM 40GB",
      memoryInGb: 40,
      secureCloud: false,
      communityCloud: true,
      securePrice: 0,
      communityPrice: 1,
      lowestPrice: { stockStatus: null },
    },
    { id: "unknown", displayName: "unknown" },
  ];
  const dataCenters = [
    {
      id: "US-CA-2",
      name: "US-CA-2",
      location: "United States",
      listed: true,
      gpuAvailability: [
        { gpuTypeId: "NVIDIA H100 80GB HBM3", stockStatus: "High" },
        { gpuTypeId: "NVIDIA RTX A5000", stockStatus: null },
      ],
    },
    {
      id: "EU-RO-1",
      location: "Europe",
      gpuAvailability: [{ gpuTypeId: "NVIDIA RTX A5000", stockStatus: "Low" }],
    },
    { id: "HIDDEN-1", listed: false, gpuAvailability: [] },
  ];

  const catalog = normalizeRunpodCatalog(gpuTypes, dataCenters, now);

  it("sorts types by price and skips placeholders", () => {
    expect(catalog.as_of).toBe("2026-10-27T05:00:00.000Z");
    expect(catalog.gpuTypes.map((t) => t.id)).toEqual([
      "NVIDIA RTX A5000",
      "NVIDIA A100-SXM4-40GB",
      "NVIDIA H100 80GB HBM3",
    ]);
  });

  it("keeps per-data-center stock only where a type is in stock", () => {
    const a5000 = catalog.gpuTypes.find((t) => t.id === "NVIDIA RTX A5000")!;
    expect(a5000.dataCenters).toEqual({ "EU-RO-1": "Low" });
    const h100 = catalog.gpuTypes.find(
      (t) => t.id === "NVIDIA H100 80GB HBM3",
    )!;
    expect(h100).toMatchObject({
      securePrice: 3.99,
      communityPrice: 2.69,
      stock: "Medium",
      dataCenters: { "US-CA-2": "High" },
    });
  });

  it("drops prices for cloud types RunPod doesn't offer", () => {
    const a100 = catalog.gpuTypes.find(
      (t) => t.id === "NVIDIA A100-SXM4-40GB",
    )!;
    expect(a100.securePrice).toBeUndefined();
    expect(a100.communityPrice).toBe(1);
    expect(a100.stock).toBeUndefined();
  });

  it("lists only listed data centers", () => {
    expect(catalog.dataCenters.map((d) => d.id)).toEqual([
      "EU-RO-1",
      "US-CA-2",
    ]);
  });
});
