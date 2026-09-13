/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import type { PersonalResourceReview } from "@cocalc/util/compute-personal-funding-review";
import {
  resolvePersonalResourceReview,
  reviewPersonalResourceOnBay,
} from "./resource-review";

const mockQuery = jest.fn();
const mockRemote = jest.fn();
const mockRegistry = jest.fn();
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: mockQuery }),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "payer",
  getConfiguredClusterBayCatalog: () => [
    { bay_id: "payer" },
    { bay_id: "resource" },
  ],
}));
jest.mock("@cocalc/server/cluster-config", () => ({
  isMultiBayCluster: () => true,
}));
jest.mock("@cocalc/server/bay-registry", () => ({
  listClusterBayRegistry: () => mockRegistry(),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({}),
}));
jest.mock("@cocalc/conat/inter-bay/api", () => ({
  createInterBayAccountLocalClient: ({ dest_bay }) => ({
    computeFundingReviewPersonalResource: (opts) => mockRemote(dest_bay, opts),
  }),
}));

const request = {
  kind: "vm" as const,
  account_id: randomUUID(),
  terms: {
    vm_id: randomUUID(),
    expected_funding_version: randomUUID(),
    home_volume_ids: [],
    lane: "prepaid" as const,
    cap_usd: "10",
    ends_at: new Date(Date.now() + 3600_000).toISOString(),
    activation: "immediate" as const,
    fallback_reasons: [],
  },
};
const result: PersonalResourceReview = {
  kind: "vm",
  review: {
    vm_id: request.terms.vm_id,
    vm_name: "Research VM",
    owner_account_id: request.account_id,
    owning_bay_id: "resource",
    resource_generation: 3,
    funding_epoch: request.terms.expected_funding_version,
    hourly_usd: "0.25",
    protected_storage_usd: "0.50",
    egress_cap_usd: "1",
    storage_delete_at: new Date(Date.now() + 86400_000).toISOString(),
    home_volumes: [],
  },
};
beforeEach(() => {
  jest.clearAllMocks();
  mockRegistry.mockResolvedValue([{ bay_id: "payer" }, { bay_id: "resource" }]);
  mockQuery.mockResolvedValue({ rows: [] });
  mockRemote.mockResolvedValue(result);
});

it("locates the owning resource bay without a local resource or beneficiary account row", async () => {
  expect(await resolvePersonalResourceReview(request)).toEqual(result);
  expect(mockRemote).toHaveBeenCalledWith("resource", request);
  expect(mockQuery).toHaveBeenCalledWith(
    expect.stringContaining("owner_account_id=$2 AND owning_bay_id=$3"),
    [request.terms.vm_id, request.account_id, "payer"],
  );
});

it("does not reveal a different owner's local resource", async () => {
  expect(await reviewPersonalResourceOnBay(request)).toBeNull();
  expect(mockRemote).not.toHaveBeenCalled();
});

it("does not convert an unavailable resource authority into an empty result", async () => {
  mockRemote.mockRejectedValue(new Error("resource bay unavailable"));
  await expect(resolvePersonalResourceReview(request)).rejects.toThrow(
    "resource bay unavailable",
  );
});

it.each(["owning_bay_id", "owner_account_id", "funding_epoch", "vm_id"])(
  "rejects contradictory %s in a private response",
  async (field) => {
    mockRemote.mockResolvedValue({
      ...result,
      review: { ...result.review, [field]: randomUUID() },
    });
    await expect(resolvePersonalResourceReview(request)).rejects.toThrow();
  },
);

it("rejects conflicting ownership across two responding bays", async () => {
  mockRegistry.mockResolvedValue([
    { bay_id: "payer" },
    { bay_id: "resource" },
    { bay_id: "duplicate" },
  ]);
  mockRemote.mockImplementation(async (bay) => ({
    ...result,
    review: { ...result.review, owning_bay_id: bay },
  }));
  await expect(resolvePersonalResourceReview(request)).rejects.toThrow(
    "Conflicting resource ownership",
  );
});

it("bounds discovery and requires a complete local registry entry", async () => {
  mockRegistry.mockResolvedValue([]);
  await expect(resolvePersonalResourceReview(request)).rejects.toThrow(
    "registry is incomplete",
  );
  mockRegistry.mockResolvedValue([
    { bay_id: "payer" },
    ...Array.from({ length: 32 }, (_, i) => ({ bay_id: `bay-${i}` })),
  ]);
  await expect(resolvePersonalResourceReview(request)).rejects.toThrow(
    "bounded bay limit",
  );
  expect(mockRemote).not.toHaveBeenCalled();
});
