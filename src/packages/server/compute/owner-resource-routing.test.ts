/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import {
  computeOwnerResourcesOnBay,
  listComputeOwnerResources,
  routeComputeOwnerRead,
  selectOwnedComputeResource,
} from "./owner-resource-routing";

const mockLocal = jest.fn();
const mockRemote = jest.fn();
const mockRegistry = jest.fn();
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "home",
  getConfiguredClusterBayCatalog: () => [],
}));
jest.mock("@cocalc/server/bay-registry", () => ({
  listClusterBayRegistry: () => mockRegistry(),
}));
jest.mock("@cocalc/server/cluster-config", () => ({
  isMultiBayCluster: () => true,
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({}),
}));
jest.mock("@cocalc/conat/inter-bay/api", () => ({
  createInterBayAccountLocalClient: () => ({
    computeOwnerResources: (r) => mockRemote(r),
  }),
}));
jest.mock("@cocalc/server/conat/api/compute", () => ({
  listVms: (r) => mockLocal(r),
  listVolumes: (r) => mockLocal(r),
}));

const owner = randomUUID();
const project = randomUUID();
const resource = (bay = "resource") => ({
  id: randomUUID(),
  name: "student-vm",
  owner_account_id: owner,
  owning_bay_id: bay,
  project_id: project,
  deleted_at: null,
});
beforeEach(() => {
  jest.clearAllMocks();
  mockRegistry.mockResolvedValue([{ bay_id: "home" }, { bay_id: "resource" }]);
  mockLocal.mockImplementation(async () => {
    expect(routeComputeOwnerRead()).toBe(false);
    return [];
  });
  mockRemote.mockResolvedValue({ kind: "vm", resources: [] });
});

it("combines authoritative owner resources and keeps local-only execution private", async () => {
  const vm = resource();
  mockRemote.mockResolvedValue({ kind: "vm", resources: [vm] });
  expect(
    await listComputeOwnerResources({ account_id: owner, kind: "vm" }),
  ).toEqual([vm]);
  expect(routeComputeOwnerRead()).toBe(true);
  expect(mockRemote).toHaveBeenCalledWith({ account_id: owner, kind: "vm" });
});

it.each(["owner", "bay", "deleted", "kind", "duplicate"])(
  "rejects a contradictory %s response rather than exposing it",
  async (field) => {
    const vm = resource();
    if (field === "owner") vm.owner_account_id = randomUUID();
    if (field === "bay") vm.owning_bay_id = "other";
    if (field === "deleted") Object.assign(vm, { deleted_at: new Date() });
    mockRemote.mockResolvedValue({
      kind: field === "kind" ? "volume" : "vm",
      resources: field === "duplicate" ? [vm, vm] : [vm],
    });
    await expect(
      listComputeOwnerResources({
        account_id: owner,
        kind: "vm",
        project_id: project,
      }),
    ).rejects.toThrow(/response|ownership/);
  },
);

it("does not turn an unavailable bay into an empty resource list", async () => {
  mockRemote.mockRejectedValue(Error("bay unavailable"));
  await expect(
    listComputeOwnerResources({ account_id: owner, kind: "vm" }),
  ).rejects.toThrow("bay unavailable");
});

it("accepts a VM selected by its project access grant, not just its original project", async () => {
  const vm = { ...resource(), project_id: randomUUID() };
  mockRemote.mockResolvedValue({ kind: "vm", resources: [vm] });
  expect(
    await listComputeOwnerResources({
      account_id: owner,
      kind: "vm",
      project_id: project,
    }),
  ).toEqual([vm]);
});

it("keeps independent volume project filtering intact", async () => {
  mockRemote.mockResolvedValue({
    kind: "volume",
    resources: [{ ...resource(), project_id: randomUUID() }],
  });
  await expect(
    listComputeOwnerResources({
      account_id: owner,
      kind: "volume",
      project_id: project,
    }),
  ).rejects.toThrow(/ownership/);
});

it("requires a complete bounded bay registry", async () => {
  mockRegistry.mockResolvedValue([{ bay_id: "resource" }]);
  await expect(
    listComputeOwnerResources({ account_id: owner, kind: "vm" }),
  ).rejects.toThrow(/incomplete/);
  mockRegistry.mockResolvedValue([
    { bay_id: "home" },
    ...Array.from({ length: 32 }, (_, i) => ({ bay_id: `bay-${i}` })),
  ]);
  await expect(
    listComputeOwnerResources({ account_id: owner, kind: "vm" }),
  ).rejects.toThrow(/bounded/);
  expect(mockRemote).not.toHaveBeenCalled();
});

it("never returns an old local copy of another bay's resource", async () => {
  mockLocal.mockResolvedValue([resource(), resource("home")]);
  const result = await computeOwnerResourcesOnBay({
    account_id: owner,
    kind: "vm",
  });
  expect(result.resources).toHaveLength(1);
  expect(result.resources[0].owning_bay_id).toBe("home");
});

it("supports non-unique display names only when the caller selects an ID", () => {
  const a = resource(),
    b = resource();
  expect(selectOwnedComputeResource([a, b], a.id)).toBe(a);
  expect(() => selectOwnedComputeResource([a, b], a.name)).toThrow(
    /use its ID/,
  );
  expect(() => selectOwnedComputeResource([a, b], "absent")).toThrow(
    /not found/,
  );
});
