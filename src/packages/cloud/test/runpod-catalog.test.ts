import { normalizeRunpodCatalog } from "../runpod/catalog";

const now = new Date("2026-10-27T05:00:00.000Z");

// Shapes as returned by GET /v2/catalog/gpus?include=AVAILABILITY&product=POD
// with cloud=SECURE and cloud=COMMUNITY (the same type rows, availability for
// that tier), and GET /v2/catalog/datacenters.
const h100 = {
  id: "NVIDIA H100 80GB HBM3",
  name: "H100 SXM",
  manufacturer: "NVIDIA",
  memory: 80,
  secure: true,
  community: true,
  price: { secure: 3.99, community: 2.69, serverless: 4.79 },
  maxCount: { secure: 8, community: 1 },
};
const rtx4090 = {
  id: "NVIDIA GeForce RTX 4090",
  name: "RTX 4090",
  memory: 24,
  secure: true,
  community: true,
  price: { secure: 0.89, community: 0.34 },
  maxCount: { secure: 8, community: 8 },
};
const mi300 = {
  id: "AMD Instinct MI300X OAM",
  name: "MI300X",
  memory: 192,
  secure: true,
  community: false,
  // RunPod still lists a community price for a cloud it doesn't offer
  price: { secure: 2.39, community: 0.5 },
  maxCount: { secure: 8, community: 0 },
};

const secure = [
  {
    ...h100,
    availability: "MEDIUM",
    dataCenters: [
      { id: "US-CA-2", name: "US-CA-2", availability: "LOW" },
      { id: "AP-IN-2", name: "AP-IN-2", availability: "NONE" },
    ],
  },
  {
    ...rtx4090,
    availability: "MEDIUM",
    dataCenters: [{ id: "EU-RO-1", name: "EU-RO-1", availability: "MEDIUM" }],
  },
  { ...mi300, availability: "NONE" },
  { name: "no id" },
];
const community = [
  {
    ...h100,
    availability: "HIGH",
    dataCenters: [{ id: "EU-FR-1", name: "EU-FR-1", availability: "HIGH" }],
  },
  // in stock on Secure but not Community: must not borrow Secure's stock
  { ...rtx4090, availability: "NONE" },
  { ...mi300, availability: "NONE" },
];

const dataCenters = [
  {
    id: "US-CA-2",
    name: "US-CA-2",
    region: "NORTH_AMERICA",
    compliance: ["SOC_2_TYPE_2"],
  },
  {
    id: "EU-FR-1",
    name: "EU-FR-1",
    region: "EUROPE",
    compliance: ["GDPR", 7],
    globalNetwork: true,
    networkVolumeTypes: ["STANDARD", 3],
  },
];

describe("normalizeRunpodCatalog", () => {
  const catalog = normalizeRunpodCatalog(
    { secure, community },
    dataCenters,
    now,
  );
  const byId = (id: string) => catalog.gpuTypes.find((t) => t.id === id)!;

  it("sorts types by their cheapest offer and skips rows without an id", () => {
    expect(catalog.as_of).toBe("2026-10-27T05:00:00.000Z");
    expect(catalog.gpuTypes.map((t) => t.id)).toEqual([
      "NVIDIA GeForce RTX 4090",
      "AMD Instinct MI300X OAM",
      "NVIDIA H100 80GB HBM3",
    ]);
  });

  it("keeps price, max count and availability separately per cloud", () => {
    expect(byId("NVIDIA H100 80GB HBM3")).toEqual({
      id: "NVIDIA H100 80GB HBM3",
      name: "H100 SXM",
      manufacturer: "NVIDIA",
      memoryGb: 80,
      secure: {
        price: 3.99,
        maxCount: 8,
        availability: "MEDIUM",
        dataCenters: { "US-CA-2": "LOW" },
      },
      community: {
        price: 2.69,
        maxCount: 1,
        availability: "HIGH",
        dataCenters: { "EU-FR-1": "HIGH" },
      },
    });
  });

  it("does not report Secure stock as Community stock", () => {
    const t = byId("NVIDIA GeForce RTX 4090");
    expect(t.secure?.availability).toBe("MEDIUM");
    expect(t.secure?.dataCenters).toEqual({ "EU-RO-1": "MEDIUM" });
    expect(t.community?.availability).toBe("NONE");
    expect(t.community?.dataCenters).toEqual({});
  });

  it("omits a cloud RunPod doesn't offer the type in", () => {
    const t = byId("AMD Instinct MI300X OAM");
    expect(t.secure?.price).toBe(2.39);
    expect(t.community).toBeUndefined();
  });

  it("lists data centers with region, compliance and networking", () => {
    expect(catalog.dataCenters).toEqual([
      {
        id: "EU-FR-1",
        name: "EU-FR-1",
        region: "EUROPE",
        compliance: ["GDPR"],
        globalNetwork: true,
        networkVolumeTypes: ["STANDARD"],
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
