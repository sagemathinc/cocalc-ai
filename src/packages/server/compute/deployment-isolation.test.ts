/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { reconcileComputeProviderInventory } from "./worker";
import {
  listProviderComputeInventory,
  stopOrphanProviderComputeInstance,
  deleteOrphanProviderComputeInstance,
  deleteOrphanProviderComputeBootDisk,
  deleteOrphanProviderComputeAddress,
} from "./provider";
import { listManagedVmDnsRecords, deleteHostDns } from "../cloud/dns";
import { observeComputeOrphan } from "./orphans";
import {
  managedComputeVmProviderName,
  computeVmDnsLabelPrefix,
} from "./resource-names";

jest.mock("./config", () => ({
  getComputeVmConfig: async () => ({ environment: "development" }),
}));
jest.mock("./db", () => ({ listComputeVmsForInventory: async () => [] }));
jest.mock("./volume-db", () => ({
  listComputeVolumesForInventory: async () => [],
}));
jest.mock("./provider", () => ({
  listProviderComputeInventory: jest.fn(),
  stopOrphanProviderComputeInstance: jest.fn(),
  deleteOrphanProviderComputeInstance: jest.fn(),
  deleteOrphanProviderComputeBootDisk: jest.fn(),
  deleteOrphanProviderComputeAddress: jest.fn(),
}));
jest.mock("../cloud/dns", () => ({
  listManagedVmDnsRecords: jest.fn(),
  deleteHostDns: jest.fn(),
}));
jest.mock("./orphans", () => ({
  computeOrphanId: (v) => v.resource_id,
  observeComputeOrphan: jest.fn(),
  updateComputeOrphan: jest.fn(),
  resolveAbsentComputeOrphans: jest.fn(),
}));

const deployment = process.env.COCALC_COMPUTE_DEPLOYMENT_ID;
afterEach(() => {
  if (deployment == null) delete process.env.COCALC_COMPUTE_DEPLOYMENT_ID;
  else process.env.COCALC_COMPUTE_DEPLOYMENT_ID = deployment;
});

it.each(["gcp", "nebius"])(
  "worker never remediates another deployment's %s resources",
  async (provider) => {
    jest.clearAllMocks();
    process.env.COCALC_COMPUTE_DEPLOYMENT_ID = "other-live-hub";
    const foreign = managedComputeVmProviderName("a".repeat(32), "development");
    const foreignDns = `${computeVmDnsLabelPrefix()}${"a".repeat(32)}.example.test`;
    process.env.COCALC_COMPUTE_DEPLOYMENT_ID = "isolated-19200";
    const own = managedComputeVmProviderName("b".repeat(32), "development");
    const names = [foreign, "cocalc-development-vm-" + "c".repeat(24), own];
    (listProviderComputeInventory as jest.Mock).mockResolvedValue({
      instances: names.map((name) => ({
        provider,
        name,
        instance_id: name,
        zone: "z",
        region: "r",
      })),
      disks: names.map((name) => ({ provider, name: `${name}-boot` })),
      addresses: names.map((name) => ({
        provider,
        id: `${name}-ip`,
        name: `${name}-ip`,
      })),
      disks_observed: true,
      addresses_observed: true,
    });
    (listManagedVmDnsRecords as jest.Mock).mockResolvedValue([
      { name: foreignDns, record_id: "foreign" },
    ]);
    (observeComputeOrphan as jest.Mock).mockImplementation(async (v) => ({
      ...v,
      id: v.resource_id,
      observation_count: 1,
    }));
    await reconcileComputeProviderInventory();
    expect(stopOrphanProviderComputeInstance).toHaveBeenCalledTimes(1);
    expect(stopOrphanProviderComputeInstance).toHaveBeenCalledWith(
      expect.objectContaining({ resource_name: own }),
    );
    expect(observeComputeOrphan).toHaveBeenCalledTimes(3);
    expect(deleteOrphanProviderComputeInstance).not.toHaveBeenCalled();
    expect(deleteOrphanProviderComputeBootDisk).not.toHaveBeenCalled();
    expect(deleteOrphanProviderComputeAddress).not.toHaveBeenCalled();
    expect(deleteHostDns).not.toHaveBeenCalled();
    jest.clearAllMocks();
    delete process.env.COCALC_COMPUTE_DEPLOYMENT_ID;
    await reconcileComputeProviderInventory();
    expect(observeComputeOrphan).not.toHaveBeenCalled();
    expect(stopOrphanProviderComputeInstance).not.toHaveBeenCalled();
  },
);
