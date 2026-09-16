/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { detachProviderComputeHomeVolume } from "./provider";
import { getComputeVmConfig } from "./config";
import {
  managedComputeVmProviderName,
  managedComputeVolumeProviderName,
} from "./resource-names";
import type { ComputeVmRow, ComputeVolumeRow } from "./types";

jest.mock("./config", () => ({ getComputeVmConfig: jest.fn() }));
jest.mock("@google-cloud/compute", () => {
  const instances = { get: jest.fn(), detachDisk: jest.fn() };
  const zonal = { wait: jest.fn() };
  return {
    __instances: instances,
    __zonal: zonal,
    InstancesClient: jest.fn(() => instances),
    ZoneOperationsClient: jest.fn(() => zonal),
    DisksClient: jest.fn(),
    AddressesClient: jest.fn(),
    RegionOperationsClient: jest.fn(),
    FirewallsClient: jest.fn(),
    SubnetworksClient: jest.fn(),
  };
});
const sdk = jest.requireMock("@google-cloud/compute");
const originalDeployment = process.env.COCALC_COMPUTE_DEPLOYMENT_ID;
const originalBay = process.env.COCALC_BAY_ID;
let vm: ComputeVmRow, volume: ComputeVolumeRow;
let disk: { source: string; deviceName: string; boot: boolean };
beforeEach(() => {
  jest.resetAllMocks();
  sdk.InstancesClient.mockImplementation(() => sdk.__instances);
  sdk.ZoneOperationsClient.mockImplementation(() => sdk.__zonal);
  process.env.COCALC_COMPUTE_DEPLOYMENT_ID = "volume-detach-test";
  process.env.COCALC_BAY_ID = "test-bay";
  jest.mocked(getComputeVmConfig).mockResolvedValue({
    environment: "development",
    gcp_project_id: "fixture-project",
    gcp_service_account_json: "{}",
  } as any);
  vm = {
    id: "12345678-1234-4234-8234-123456789abc",
    owner_account_id: "owner",
    owning_bay_id: "test-bay",
    provider: "gcp",
    region: "us-central1",
    zone: "us-central1-a",
    desired_state: "stopped",
    home_volume_id: "12345678-1234-4234-8234-123456789abd",
    metadata: {},
  } as ComputeVmRow;
  vm.provider_instance_id = managedComputeVmProviderName(vm.id, "development");
  volume = {
    id: vm.home_volume_id,
    owner_account_id: vm.owner_account_id,
    owning_bay_id: vm.owning_bay_id,
    provider: vm.provider,
    region: vm.region,
    zone: vm.zone,
    attached_vm_id: vm.id,
  } as ComputeVolumeRow;
  volume.provider_disk_id = managedComputeVolumeProviderName(
    volume.id,
    "development",
  );
  disk = {
    source: `https://www.googleapis.com/compute/v1/projects/fixture-project/zones/${vm.zone}/disks/${volume.provider_disk_id}`,
    deviceName: "home-data",
    boot: false,
  };
  sdk.__instances.get.mockResolvedValue([
    {
      status: "TERMINATED",
      disks: [
        { boot: true, deviceName: "boot", source: "other-boot-disk" },
        disk,
      ],
    },
  ]);
  sdk.__instances.detachDisk.mockResolvedValue([
    { name: "detach", status: "PENDING" },
  ]);
  sdk.__zonal.wait.mockResolvedValue([{ name: "detach", status: "DONE" }]);
});
afterEach(() => {
  if (originalDeployment == null)
    delete process.env.COCALC_COMPUTE_DEPLOYMENT_ID;
  else process.env.COCALC_COMPUTE_DEPLOYMENT_ID = originalDeployment;
  if (originalBay == null) delete process.env.COCALC_BAY_ID;
  else process.env.COCALC_BAY_ID = originalBay;
});

it("detaches only the exact home device from an independently confirmed stopped VM and waits for completion", async () => {
  await detachProviderComputeHomeVolume(vm, volume);
  expect(sdk.__instances.detachDisk).toHaveBeenCalledWith({
    project: "fixture-project",
    zone: vm.zone,
    instance: vm.provider_instance_id,
    deviceName: "home-data",
  });
  expect(sdk.__zonal.wait).toHaveBeenCalledTimes(1);
});
it.each([
  "running",
  "boot",
  "duplicate",
  "foreign-deployment",
  "wrong-owner",
  "wrong-bay",
  "wrong-attachment",
])("refuses %s without detaching", async (failure) => {
  if (failure === "running")
    sdk.__instances.get.mockResolvedValue([
      { status: "RUNNING", disks: [disk] },
    ]);
  if (failure === "boot") disk.boot = true;
  if (failure === "duplicate")
    sdk.__instances.get.mockResolvedValue([
      { status: "TERMINATED", disks: [disk, disk] },
    ]);
  if (failure === "foreign-deployment")
    process.env.COCALC_COMPUTE_DEPLOYMENT_ID = "other-deployment";
  if (failure === "wrong-owner") volume.owner_account_id = "other-owner";
  if (failure === "wrong-bay") volume.owning_bay_id = "other-bay";
  if (failure === "wrong-attachment") volume.attached_vm_id = "other-vm";
  await expect(detachProviderComputeHomeVolume(vm, volume)).rejects.toThrow();
  expect(sdk.__instances.detachDisk).not.toHaveBeenCalled();
});
it("replays an already detached or missing instance without a mutation", async () => {
  sdk.__instances.get
    .mockResolvedValueOnce([{ status: "TERMINATED", disks: [] }])
    .mockRejectedValueOnce({ code: 404 });
  await detachProviderComputeHomeVolume(vm, volume);
  await detachProviderComputeHomeVolume(vm, volume);
  expect(sdk.__instances.detachDisk).not.toHaveBeenCalled();
});
it("does not turn an uncertain provider read or failed detach operation into success", async () => {
  sdk.__instances.get.mockRejectedValueOnce(Error("unavailable"));
  await expect(detachProviderComputeHomeVolume(vm, volume)).rejects.toThrow(
    "unavailable",
  );
  sdk.__zonal.wait.mockResolvedValueOnce([
    {
      name: "detach",
      status: "DONE",
      error: { errors: [{ message: "denied" }] },
    },
  ]);
  await expect(detachProviderComputeHomeVolume(vm, volume)).rejects.toThrow(
    "denied",
  );
});
