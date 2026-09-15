/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  listProviderComputeInventory,
  stopOrphanProviderComputeInstance,
  deleteOrphanProviderComputeInstance,
  deleteOrphanProviderComputeAddress,
  deleteOrphanProviderComputeBootDisk,
} from "./provider";
import { getComputeVmConfig } from "./config";
import { getNebiusRegionKeys } from "../cloud/nebius-credentials";
import { getProviderContext } from "../cloud/provider-context";
import {
  managedComputeVmProviderName,
  managedComputeVolumeProviderName,
} from "./resource-names";
import type { ComputeVmRow, ComputeVolumeRow } from "./types";

// SDK and configuration dependencies are mocked; provider.ts performs the real
// inventory filtering and orphan mutation ownership checks in this suite.
jest.mock("@cocalc/cloud", () => ({
  GcpProvider: jest.fn(() => ({
    listInstances: jest.fn(),
    stopHost: jest.fn(),
    deleteHost: jest.fn(),
  })),
  NebiusProvider: jest.fn(() => ({
    listInstances: jest.fn(),
    listPersistentDisks: jest.fn(),
    listPublicAddresses: jest.fn(),
    stopHost: jest.fn(),
    deleteHost: jest.fn(),
    releasePublicAddress: jest.fn(),
    deletePersistentDisk: jest.fn(),
  })),
}));
jest.mock("@google-cloud/compute", () => {
  const clients = {
    disks: { aggregatedListAsync: jest.fn(), delete: jest.fn() },
    addresses: { aggregatedListAsync: jest.fn(), delete: jest.fn() },
    regional: { wait: jest.fn() },
    zonal: { wait: jest.fn() },
  };
  return {
    __clients: clients,
    DisksClient: jest.fn(() => clients.disks),
    AddressesClient: jest.fn(() => clients.addresses),
    RegionOperationsClient: jest.fn(() => clients.regional),
    ZoneOperationsClient: jest.fn(() => clients.zonal),
    FirewallsClient: jest.fn(),
    InstancesClient: jest.fn(),
    SubnetworksClient: jest.fn(),
  };
});
jest.mock("./config", () => ({ getComputeVmConfig: jest.fn() }));
jest.mock("../cloud/host-util", () => ({
  buildHostSpec: jest.fn(),
  getGcpAcceleratorImage: jest.fn(),
}));
jest.mock("../cloud/nebius-credentials", () => ({
  getNebiusRegionKeys: jest.fn(),
}));
jest.mock("../cloud/provider-context", () => ({
  getProviderContext: jest.fn(),
}));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => ({}),
}));

const gcp = jest.requireMock("@cocalc/cloud").GcpProvider.mock.results[0].value;
const nebius =
  jest.requireMock("@cocalc/cloud").NebiusProvider.mock.results[0].value;
const clients = jest.requireMock("@google-cloud/compute").__clients;
const originalDeployment = process.env.COCALC_COMPUTE_DEPLOYMENT_ID;
const originalBay = process.env.COCALC_BAY_ID;
const id = "12345678-1234-4abc-9def-123456789abc";

async function* scoped(field: string, values: unknown[]) {
  yield ["zones/test-zone", { [field]: values }];
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.COCALC_COMPUTE_DEPLOYMENT_ID = "test-copy";
  process.env.COCALC_BAY_ID = "test-bay";
  jest.mocked(getComputeVmConfig).mockResolvedValue({
    environment: "development",
    gcp_service_account_json: "{}",
    gcp_project_id: "fake-project",
  } as any);
  jest.mocked(getNebiusRegionKeys).mockReturnValue([]);
  jest
    .mocked(getProviderContext)
    .mockResolvedValue({ creds: { fake: true } } as any);
  for (const fn of [
    gcp.listInstances,
    nebius.listInstances,
    nebius.listPersistentDisks,
    nebius.listPublicAddresses,
  ])
    fn.mockResolvedValue([]);
  clients.disks.aggregatedListAsync.mockImplementation(() =>
    scoped("disks", []),
  );
  clients.addresses.aggregatedListAsync.mockImplementation(() =>
    scoped("addresses", []),
  );
  clients.disks.delete.mockResolvedValue([
    { name: "delete-disk", status: "DONE" },
  ]);
  clients.addresses.delete.mockResolvedValue([
    { name: "delete-address", status: "DONE" },
  ]);
});
afterEach(() => {
  if (originalDeployment == null)
    delete process.env.COCALC_COMPUTE_DEPLOYMENT_ID;
  else process.env.COCALC_COMPUTE_DEPLOYMENT_ID = originalDeployment;
  if (originalBay == null) delete process.env.COCALC_BAY_ID;
  else process.env.COCALC_BAY_ID = originalBay;
});

function names() {
  const own = managedComputeVmProviderName(id, "development");
  const volume = managedComputeVolumeProviderName(id, "development");
  const otherEnvironment = managedComputeVmProviderName(id, "production");
  process.env.COCALC_COMPUTE_DEPLOYMENT_ID = "live-original";
  const foreign = managedComputeVmProviderName(id, "development");
  process.env.COCALC_COMPUTE_DEPLOYMENT_ID = "test-copy";
  process.env.COCALC_BAY_ID = "other-bay";
  const otherBay = managedComputeVmProviderName(id, "development");
  process.env.COCALC_BAY_ID = "test-bay";
  return {
    own,
    volume,
    excluded: [
      foreign,
      otherBay,
      otherEnvironment,
      "cocalc-development-vm-" + "a".repeat(24),
      "cocalc-vm-" + "a".repeat(24),
      own.slice(0, -1),
      `${own}/disk`,
      "unmanaged-disk",
    ],
  };
}

function inventoryRows(provider: "gcp" | "nebius", names: string[]) {
  const instances = names.map((name) => ({
    name,
    instance_id: `instance:${name}`,
    status: "running",
    zone: "test-zone",
  }));
  const disks = names.map((name) => ({ name, id: `disk:${name}` }));
  const addresses = names.map((name) => ({
    name,
    id: `address:${name}`,
    address: "192.0.2.1",
    ip: "192.0.2.1",
  }));
  if (provider === "gcp") {
    gcp.listInstances.mockResolvedValue(instances);
    clients.disks.aggregatedListAsync.mockImplementation(() =>
      scoped("disks", disks),
    );
    clients.addresses.aggregatedListAsync.mockImplementation(() =>
      scoped("addresses", addresses),
    );
  } else {
    jest.mocked(getNebiusRegionKeys).mockReturnValue(["test-region"]);
    nebius.listInstances.mockResolvedValue(instances);
    nebius.listPersistentDisks.mockResolvedValue(disks);
    nebius.listPublicAddresses.mockResolvedValue(addresses);
  }
}

function assertReadOnly() {
  for (const fn of [
    gcp.stopHost,
    gcp.deleteHost,
    nebius.stopHost,
    nebius.deleteHost,
    nebius.releasePublicAddress,
    nebius.deletePersistentDisk,
    clients.disks.delete,
    clients.addresses.delete,
  ])
    expect(fn).not.toHaveBeenCalled();
}

it.each(["gcp", "nebius"] as const)(
  "real %s inventory excludes foreign deployments, bays, environments and malformed prefixes",
  async (provider) => {
    const { own, volume, excluded } = names();
    inventoryRows(provider, [
      own,
      `${own}-boot`,
      `${own}-ip`,
      volume,
      ...excluded,
    ]);
    const result = await listProviderComputeInventory({
      vms: [{ provider, region: "test-region", metadata: {} } as ComputeVmRow],
      volumes: [],
    });
    expect(result.instances.map((row) => row.name)).toEqual([
      own,
      `${own}-boot`,
      `${own}-ip`,
    ]);
    expect(result.disks.map((row) => row.name)).toEqual([
      own,
      `${own}-boot`,
      `${own}-ip`,
      volume,
    ]);
    expect(result.addresses.map((row) => row.name)).toEqual([
      own,
      `${own}-boot`,
      `${own}-ip`,
    ]);
    expect(result.disks_observed).toBe(true);
    expect(result.addresses_observed).toBe(true);
    assertReadOnly();
  },
);

it.each(["gcp", "nebius"] as const)(
  "%s explicitly referenced legacy records remain visible but cannot be orphan-remediated",
  async (provider) => {
    const legacy = "cocalc-development-vm-" + "f".repeat(24);
    inventoryRows(provider, [
      legacy,
      `${legacy}-boot`,
      `${legacy}-ip`,
      "unreferenced",
    ]);
    const vm = {
      provider,
      region: "test-region",
      metadata: { provider_instance_name: legacy },
      boot_disk_id: `${legacy}-boot`,
      public_address_id:
        provider === "gcp" ? `${legacy}-ip` : `address:${legacy}-ip`,
    } as ComputeVmRow;
    const result = await listProviderComputeInventory({
      vms: [vm],
      volumes: [],
    });
    expect(result.instances.map((row) => row.name)).toEqual([legacy]);
    expect(result.disks.map((row) => row.name)).toEqual([`${legacy}-boot`]);
    expect(result.addresses.map((row) => row.name)).toEqual([`${legacy}-ip`]);
    await expect(
      deleteOrphanProviderComputeInstance({
        provider,
        resource_name: legacy,
        resource_id: `instance:${legacy}`,
        region: "test-region",
        zone: "test-zone",
      }),
    ).rejects.toThrow("outside this compute deployment and bay");
    assertReadOnly();
  },
);

it.each(["gcp", "nebius"] as const)(
  "without a deployment ID, %s inventory discovers no unreferenced resources",
  async (provider) => {
    const { own } = names();
    inventoryRows(provider, [own, `${own}-boot`, `${own}-ip`]);
    delete process.env.COCALC_COMPUTE_DEPLOYMENT_ID;
    const result = await listProviderComputeInventory({
      vms: [{ provider, region: "test-region", metadata: {} } as ComputeVmRow],
      volumes: [],
    });
    expect(result.instances).toEqual([]);
    expect(result.disks).toEqual([]);
    expect(result.addresses).toEqual([]);
    assertReadOnly();
  },
);

it.each(["gcp", "nebius"] as const)(
  "orphan %s ownership is rechecked after discovery and before credential loading",
  async (provider) => {
    const { own } = names();
    process.env.COCALC_BAY_ID = "changed-bay";
    for (const mutate of [
      stopOrphanProviderComputeInstance,
      deleteOrphanProviderComputeInstance,
      deleteOrphanProviderComputeAddress,
      deleteOrphanProviderComputeBootDisk,
    ]) {
      await expect(
        mutate({
          provider,
          resource_id: own,
          resource_name: own,
          region: "test-region",
          zone: "test-zone",
        }),
      ).rejects.toThrow("outside this compute deployment and bay");
    }
    expect(getProviderContext).not.toHaveBeenCalled();
    assertReadOnly();
  },
);

it.each(["gcp", "nebius"] as const)(
  "owned %s orphan deletion preserves separate data disks",
  async (provider) => {
    const { own, volume } = names();
    await deleteOrphanProviderComputeInstance({
      provider,
      resource_id: `instance:${own}`,
      resource_name: own,
      region: "test-region",
      zone: "test-zone",
    });
    const adapter = provider === "gcp" ? gcp : nebius;
    expect(adapter.deleteHost).toHaveBeenCalledWith(
      expect.objectContaining({ instance_id: `instance:${own}` }),
      expect.anything(),
      { preserveDataDisk: true },
    );
    await expect(
      deleteOrphanProviderComputeBootDisk({
        provider,
        resource_id: volume,
        resource_name: volume,
        region: "test-region",
        zone: "test-zone",
      }),
    ).rejects.toThrow("outside this compute deployment and bay");
    expect(clients.disks.delete).not.toHaveBeenCalled();
    expect(nebius.deletePersistentDisk).not.toHaveBeenCalled();
  },
);

it("an SDK inventory failure is not reported as an empty authoritative observation", async () => {
  gcp.listInstances.mockRejectedValueOnce(
    Error("provider inventory unavailable"),
  );
  await expect(
    listProviderComputeInventory({
      vms: [{ provider: "gcp", metadata: {} } as ComputeVmRow],
      volumes: [],
    }),
  ).rejects.toThrow("provider inventory unavailable");
  assertReadOnly();
});

it("a volume-only GCP database still observes the real disk inventory", async () => {
  const { volume } = names();
  inventoryRows("gcp", [volume]);
  const result = await listProviderComputeInventory({
    vms: [],
    volumes: [
      { provider: "gcp", provider_disk_id: volume } as ComputeVolumeRow,
    ],
  });
  expect(result.disks.map((row) => row.name)).toEqual([volume]);
  expect(result.instances).toEqual([]);
  assertReadOnly();
});

it.each(["disks", "addresses"] as const)(
  "a failed GCP %s page does not return partial authoritative inventory",
  async (field) => {
    const { own } = names();
    inventoryRows("gcp", [own]);
    clients[field].aggregatedListAsync.mockImplementation(async function* () {
      yield ["zones/test-zone", { [field]: [{ name: own }] }];
      throw Error("next inventory page unavailable");
    });
    await expect(
      listProviderComputeInventory({
        vms: [{ provider: "gcp", metadata: {} } as ComputeVmRow],
        volumes: [],
      }),
    ).rejects.toThrow("next inventory page unavailable");
    assertReadOnly();
  },
);

it.each(["listPersistentDisks", "listPublicAddresses"] as const)(
  "a failed Nebius %s request does not return partial authoritative inventory",
  async (method) => {
    const { own } = names();
    inventoryRows("nebius", [own]);
    nebius[method].mockRejectedValueOnce(Error("inventory unavailable"));
    await expect(
      listProviderComputeInventory({ vms: [], volumes: [] }),
    ).rejects.toThrow("inventory unavailable");
    assertReadOnly();
  },
);
