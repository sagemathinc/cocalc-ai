import { normalizeRunpodCatalog } from "../runpod/catalog";

const now = new Date("2026-10-27T05:00:00.000Z");

// Shapes as returned by GET /v2/catalog/gpus?include=AVAILABILITY&product=POD
// and GET /v2/catalog/datacenters.
const gpuTypes = [
  {
    id: "NVIDIA H100 80GB HBM3",
    name: "H100 SXM",
    memory: 80,
    secure: true,
    community: true,
    price: { secure: 3.99, community: 2.69, serverless: 4.79 },
    maxCount: { secure: 8, community: 1 },
    availability: "MEDIUM",
    dataCenters: [
      { id: "US-CA-2", name: "US-CA-2", availability: "LOW" },
      { id: "EU-FR-1", name: "EU-FR-1", availability: "HIGH" },
      { id: "AP-IN-2", name: "AP-IN-2", availability: "NONE" },
    ],
  },
  {
    id: "NVIDIA RTX A5000",
    name: "RTX A5000",
    memory: 24,
    secure: true,
    community: true,
    price: { secure: 0.27, community: 0.16 },
    maxCount: { secure: 10, community: 10 },
    availability: "NONE",
  },
  {
    id: "AMD Instinct MI300X OAM",
    name: "MI300X",
    memory: 192,
    secure: true,
    community: false,
    // RunPod still lists a community price for a cloud it doesn't offer
    price: { secure: 2.39, community: 0.5 },
    maxCount: { secure: 8, community: 0 },
    availability: "NONE",
  },
  { name: "no id" },
];

const dataCenters = [
  {
    id: "US-CA-2",
    name: "US-CA-2",
    region: "NORTH_AMERICA",
    compliance: ["SOC_2_TYPE_2"],
  },
  { id: "EU-FR-1", name: "EU-FR-1", region: "EUROPE", compliance: ["GDPR", 7] },
];

describe("normalizeRunpodCatalog", () => {
  const catalog = normalizeRunpodCatalog(gpuTypes, dataCenters, now);

  it("sorts types by price and skips rows without an id", () => {
    expect(catalog.as_of).toBe("2026-10-27T05:00:00.000Z");
    expect(catalog.gpuTypes.map((t) => t.id)).toEqual([
      "NVIDIA RTX A5000",
      "AMD Instinct MI300X OAM",
      "NVIDIA H100 80GB HBM3",
    ]);
  });

  it("keeps per-data-center availability only where in stock", () => {
    const h100 = catalog.gpuTypes.find(
      (t) => t.id === "NVIDIA H100 80GB HBM3",
    )!;
    expect(h100).toEqual({
      id: "NVIDIA H100 80GB HBM3",
      name: "H100 SXM",
      memoryGb: 80,
      securePrice: 3.99,
      communityPrice: 2.69,
      maxCountSecure: 8,
      maxCountCommunity: 1,
      availability: "MEDIUM",
      dataCenters: { "US-CA-2": "LOW", "EU-FR-1": "HIGH" },
    });
    const a5000 = catalog.gpuTypes.find((t) => t.id === "NVIDIA RTX A5000")!;
    expect(a5000.availability).toBe("NONE");
    expect(a5000.dataCenters).toEqual({});
  });

  it("drops prices for a cloud type RunPod doesn't offer", () => {
    const mi300 = catalog.gpuTypes.find(
      (t) => t.id === "AMD Instinct MI300X OAM",
    )!;
    expect(mi300.securePrice).toBe(2.39);
    expect(mi300.communityPrice).toBeUndefined();
    expect(mi300.maxCountCommunity).toBeUndefined();
  });

  it("lists data centers with region and compliance", () => {
    expect(catalog.dataCenters).toEqual([
      {
        id: "EU-FR-1",
        name: "EU-FR-1",
        region: "EUROPE",
        compliance: ["GDPR"],
      },
      {
        id: "US-CA-2",
        name: "US-CA-2",
        region: "NORTH_AMERICA",
        compliance: ["SOC_2_TYPE_2"],
      },
    ]);
  });
});
