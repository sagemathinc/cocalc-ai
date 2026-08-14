import { NebiusProvider } from "../nebius/provider";
import type { HostSpec } from "../types";
import {
  DiskSpec_DiskType,
  InstanceRecoveryPolicy,
  PreemptibleSpec_PreemptionPolicy,
} from "@nebius/js-sdk/api/nebius/compute/v1/index";

const disksCreateMock = jest.fn();
const disksListMock = jest.fn();
const disksGetMock = jest.fn();
const disksDeleteMock = jest.fn();
const disksUpdateMock = jest.fn();
const instancesCreateMock = jest.fn();
const instancesDeleteMock = jest.fn();
const instancesGetMock = jest.fn();
const instancesListMock = jest.fn();
const instancesStopMock = jest.fn();
const instancesUpdateMock = jest.fn();
const allocationsCreateMock = jest.fn();
const allocationsGetMock = jest.fn();
const allocationsGetByNameMock = jest.fn();
const allocationsDeleteMock = jest.fn();

jest.mock("../nebius/client", () => {
  class NebiusClient {
    readonly disks = {
      create: disksCreateMock,
      list: disksListMock,
      get: disksGetMock,
      delete: disksDeleteMock,
      update: disksUpdateMock,
    };
    readonly instances = {
      create: instancesCreateMock,
      delete: instancesDeleteMock,
      get: instancesGetMock,
      list: instancesListMock,
      stop: instancesStopMock,
      update: instancesUpdateMock,
    };
    readonly allocations = {
      create: allocationsCreateMock,
      get: allocationsGetMock,
      getByName: allocationsGetByNameMock,
      delete: allocationsDeleteMock,
    };

    constructor(private creds: any) {}

    parentId() {
      return this.creds.parentId;
    }
  }

  return { NebiusClient };
});

function diskOp(id: string) {
  return {
    wait: jest.fn(async () => undefined),
    resourceId: () => id,
  };
}

function instanceOp(id: string) {
  return {
    wait: jest.fn(async () => undefined),
    resourceId: () => id,
  };
}

function buildSpec(overrides: Partial<HostSpec> = {}): HostSpec {
  return {
    name: "spot-host",
    region: "eu-north1",
    cpu: 4,
    ram_gb: 16,
    disk_gb: 200,
    disk_type: "ssd",
    metadata: {
      machine_type: "spot-enabled-machine",
      platform: "spot-platform",
      source_image: "image-1",
      storage_mode: "persistent",
    },
    ...overrides,
  };
}

describe("NebiusProvider", () => {
  beforeEach(() => {
    jest.useRealTimers();
    disksCreateMock.mockReset();
    disksListMock.mockReset();
    disksGetMock.mockReset();
    disksDeleteMock.mockReset();
    disksUpdateMock.mockReset();
    instancesCreateMock.mockReset();
    instancesDeleteMock.mockReset();
    instancesGetMock.mockReset();
    instancesListMock.mockReset();
    instancesStopMock.mockReset();
    instancesUpdateMock.mockReset();
    allocationsCreateMock.mockReset();
    allocationsGetMock.mockReset();
    allocationsGetByNameMock.mockReset();
    allocationsDeleteMock.mockReset();
    disksListMock.mockResolvedValue({ items: [], nextPageToken: "" });
    disksGetMock.mockResolvedValue({
      metadata: {
        id: "disk-id",
        parentId: "project-1",
        name: "disk-name",
        resourceVersion: 7,
      },
      spec: {
        size: {
          $case: "sizeGibibytes",
          sizeGibibytes: 1000,
        },
      },
    });
    disksCreateMock
      .mockResolvedValueOnce(diskOp("boot-disk"))
      .mockResolvedValueOnce(diskOp("data-disk"));
    instancesCreateMock.mockResolvedValue(instanceOp("instance-1"));
    instancesListMock.mockResolvedValue({ items: [], nextPageToken: "" });
    instancesDeleteMock.mockResolvedValue(instanceOp("instance-1"));
    instancesUpdateMock.mockResolvedValue(instanceOp("instance-1"));
    disksDeleteMock.mockResolvedValue(diskOp("deleted-disk"));
    disksUpdateMock.mockResolvedValue(diskOp("updated-disk"));
  });

  it("creates independent replicated SSD volumes with the requested type", async () => {
    disksCreateMock.mockReset().mockResolvedValueOnce(diskOp("home-disk"));

    await new NebiusProvider().ensurePersistentDisk(
      { name: "managed-home", size_gb: 50, disk_type: "ssd" },
      {
        parentId: "project-1",
        serviceAccountId: "svc-1",
        publicKeyId: "pub-1",
        privateKeyPem: "key",
        sshPublicKey: "ssh-ed25519 AAAA",
        subnetId: "subnet-1",
      },
    );

    expect(disksCreateMock.mock.calls[0][0].spec.type).toBe(
      DiskSpec_DiskType.NETWORK_SSD,
    );
  });

  it("allocates a static public address from the configured subnet", async () => {
    allocationsGetByNameMock.mockRejectedValue(new Error("NOT_FOUND"));
    allocationsCreateMock.mockResolvedValue(diskOp("allocation-1"));
    allocationsGetMock.mockResolvedValue({
      metadata: { id: "allocation-1" },
      status: { static: true, details: { allocatedCidr: "203.0.113.4/32" } },
    });

    const result = await new NebiusProvider().ensurePublicAddress(
      { name: "managed-address" },
      {
        parentId: "project-1",
        serviceAccountId: "svc-1",
        publicKeyId: "pub-1",
        privateKeyPem: "key",
        sshPublicKey: "ssh-ed25519 AAAA",
        subnetId: "subnet-1",
      },
    );

    expect(result).toEqual({ id: "allocation-1", ip: "203.0.113.4" });
    expect(
      allocationsCreateMock.mock.calls[0][0].spec.ipSpec.ipv4Public.pool,
    ).toEqual({ $case: "subnetId", subnetId: "subnet-1" });
  });

  it("does not send provisional instance names to ID-only APIs", async () => {
    const provider = new NebiusProvider();
    const runtime = {
      provider: "nebius" as const,
      instance_id: "cocalc-vm-provisional-name",
      metadata: { provisional_instance_id: true },
    };
    const creds = {
      parentId: "project-1",
      serviceAccountId: "svc-1",
      publicKeyId: "pub-1",
      privateKeyPem: "key",
      sshPublicKey: "ssh-ed25519 AAAA",
      subnetId: "subnet-1",
    };

    const instance = await provider.getInstance(runtime, creds);
    await provider.stopHost(runtime, creds);
    await provider.deleteHost(runtime, creds);
    await provider.deleteInstanceOnly(runtime, creds);

    expect(instance).toBeUndefined();
    expect(instancesGetMock).not.toHaveBeenCalled();
    expect(instancesStopMock).not.toHaveBeenCalled();
    expect(instancesDeleteMock).not.toHaveBeenCalled();
  });

  it("creates preemptible instances for spot hosts", async () => {
    const provider = new NebiusProvider();
    await provider.createHost(
      buildSpec({
        pricing_model: "spot",
      }),
      {
        parentId: "project-1",
        serviceAccountId: "svc-1",
        publicKeyId: "pub-1",
        privateKeyPem: "key",
        sshPublicKey: "ssh-ed25519 AAAA",
        subnetId: "subnet-1",
      },
    );

    const createArgs = instancesCreateMock.mock.calls[0][0];
    expect(createArgs.spec.preemptible).toBeDefined();
    expect(createArgs.spec.preemptible.onPreemption).toBe(
      PreemptibleSpec_PreemptionPolicy.STOP,
    );
    expect(createArgs.spec.preemptible.priority).toBe(3);
    expect(createArgs.spec.recoveryPolicy).toBe(InstanceRecoveryPolicy.FAIL);
  });

  it("adopts a matching instance from the paginated parent listing", async () => {
    instancesListMock
      .mockResolvedValueOnce({ items: [], nextPageToken: "next" })
      .mockResolvedValueOnce({
        items: [
          {
            metadata: { id: "instance-existing", name: "spot-host" },
            spec: {
              networkInterfaces: [
                {
                  subnetId: "subnet-1",
                  publicIpAddress: {
                    allocation: {
                      $case: "allocationId",
                      allocationId: "address-1",
                    },
                  },
                  securityGroups: [{ id: "security-group-1" }],
                },
              ],
              bootDisk: {
                type: {
                  $case: "existingDisk",
                  existingDisk: { id: "boot-existing" },
                },
              },
              secondaryDisks: [
                {
                  deviceId: "home",
                  type: {
                    $case: "existingDisk",
                    existingDisk: { id: "home-existing" },
                  },
                },
              ],
            },
            status: {
              networkInterfaces: [
                { publicIpAddress: { address: "192.0.2.10" } },
              ],
            },
          },
        ],
        nextPageToken: "",
      });

    const runtime = await new NebiusProvider().createHost(
      buildSpec({
        metadata: {
          machine_type: "spot-enabled-machine",
          platform: "spot-platform",
          source_image: "image-1",
          public_address_id: "address-1",
          security_group_ids: ["security-group-1"],
          shared_disk_device_id: "home",
          disable_service_account: true,
        },
      }),
      {
        parentId: "project-1",
        serviceAccountId: "svc-1",
        publicKeyId: "pub-1",
        privateKeyPem: "key",
        sshPublicKey: "ssh-ed25519 AAAA",
        subnetId: "subnet-1",
      },
    );

    expect(instancesListMock).toHaveBeenCalledTimes(2);
    expect(instancesCreateMock).not.toHaveBeenCalled();
    expect(runtime).toMatchObject({
      instance_id: "instance-existing",
      public_ip: "192.0.2.10",
      metadata: {
        diskIds: { boot: "boot-existing", scratch: "home-existing" },
      },
    });
  });

  it("creates and attaches a shared scratch disk", async () => {
    disksCreateMock
      .mockReset()
      .mockResolvedValueOnce(diskOp("boot-disk"))
      .mockResolvedValueOnce(diskOp("data-disk"))
      .mockResolvedValueOnce(diskOp("scratch-disk"));
    const provider = new NebiusProvider();
    const runtime = await provider.createHost(
      buildSpec({
        shared_disk_gb: 1000,
        shared_disk_type: "balanced",
      }),
      {
        parentId: "project-1",
        serviceAccountId: "svc-1",
        publicKeyId: "pub-1",
        privateKeyPem: "key",
        sshPublicKey: "ssh-ed25519 AAAA",
        subnetId: "subnet-1",
      },
    );

    expect(disksCreateMock).toHaveBeenCalledTimes(3);
    expect(disksCreateMock.mock.calls[2][0].metadata.name).toBe(
      "spot-host-scratch",
    );
    expect(disksCreateMock.mock.calls[2][0].spec.type.name).toBe(
      "NETWORK_SSD_NON_REPLICATED",
    );
    const createArgs = instancesCreateMock.mock.calls[0][0];
    expect(
      createArgs.spec.secondaryDisks.map((disk: any) => disk.deviceId),
    ).toEqual(["data", "scratch"]);
    expect(runtime.metadata).toMatchObject({
      diskIds: {
        boot: "boot-disk",
        data: "data-disk",
        scratch: "scratch-disk",
      },
      shared_disk_id: "scratch-disk",
      shared_disk_name: "spot-host-scratch",
    });
  });

  it("reattaches an existing shared scratch disk", async () => {
    disksCreateMock
      .mockReset()
      .mockResolvedValueOnce(diskOp("boot-disk"))
      .mockResolvedValueOnce(diskOp("data-disk"));
    const provider = new NebiusProvider();
    const runtime = await provider.createHost(
      buildSpec({
        shared_disk_gb: 1000,
        shared_disk_type: "ssd",
        metadata: {
          machine_type: "spot-enabled-machine",
          platform: "spot-platform",
          source_image: "image-1",
          storage_mode: "persistent",
          shared_disk_id: "scratch-existing",
        },
      }),
      {
        parentId: "project-1",
        serviceAccountId: "svc-1",
        publicKeyId: "pub-1",
        privateKeyPem: "key",
        sshPublicKey: "ssh-ed25519 AAAA",
        subnetId: "subnet-1",
      },
    );

    expect(disksCreateMock).toHaveBeenCalledTimes(2);
    const createArgs = instancesCreateMock.mock.calls[0][0];
    expect(
      createArgs.spec.secondaryDisks.map((disk: any) => disk.deviceId),
    ).toEqual(["data", "scratch"]);
    expect(runtime.metadata).toMatchObject({
      diskIds: {
        scratch: "scratch-existing",
      },
    });
  });

  it("reports observed machine type and spot pricing for existing instances", async () => {
    const provider = new NebiusProvider();
    instancesGetMock.mockResolvedValue({
      metadata: {
        id: "instance-1",
        name: "host-1",
      },
      spec: {
        resources: {
          platform: "spot-platform",
          size: {
            $case: "preset",
            preset: "spot-enabled-machine",
          },
        },
        preemptible: {
          priority: 3,
        },
      },
      status: {
        state: {
          name: "STOPPED",
        },
        networkInterfaces: [
          {
            publicIpAddress: {
              address: "192.0.2.44",
            },
          },
        ],
      },
    });

    const instance = await provider.getInstance(
      {
        provider: "nebius",
        instance_id: "instance-1",
        ssh_user: "ubuntu",
      },
      {
        parentId: "project-1",
        serviceAccountId: "svc-1",
        publicKeyId: "pub-1",
        privateKeyPem: "key",
        sshPublicKey: "ssh-ed25519 AAAA",
        subnetId: "subnet-1",
      },
    );

    expect(instance).toMatchObject({
      instance_id: "instance-1",
      name: "host-1",
      status: "STOPPED",
      public_ip: "192.0.2.44",
      metadata: {
        machine_type: "spot-enabled-machine",
        platform: "spot-platform",
        pricing_model: "spot",
        preemptible: true,
      },
    });
  });

  it("does not classify default empty preemptible specs as spot", async () => {
    const provider = new NebiusProvider();
    instancesGetMock.mockResolvedValue({
      metadata: {
        id: "instance-1",
        name: "host-1",
      },
      spec: {
        resources: {
          platform: "standard-platform",
          size: {
            $case: "preset",
            preset: "standard-machine",
          },
        },
        preemptible: {
          onPreemption: PreemptibleSpec_PreemptionPolicy.UNSPECIFIED,
          priority: 0,
        },
      },
      status: {
        state: {
          name: "STOPPED",
        },
      },
    });

    const instance = await provider.getInstance(
      {
        provider: "nebius",
        instance_id: "instance-1",
        ssh_user: "ubuntu",
      },
      {
        parentId: "project-1",
        serviceAccountId: "svc-1",
        publicKeyId: "pub-1",
        privateKeyPem: "key",
        sshPublicKey: "ssh-ed25519 AAAA",
        subnetId: "subnet-1",
      },
    );

    expect(instance?.metadata).toMatchObject({
      pricing_model: "on_demand",
      preemptible: false,
    });
  });

  it("waits for disks to detach before deleting a deprovisioned host", async () => {
    jest.useFakeTimers();
    const provider = new NebiusProvider();
    disksGetMock
      .mockResolvedValueOnce({
        status: {
          readWriteAttachment: "instance-1",
          reconciling: true,
          lockState: undefined,
        },
      })
      .mockResolvedValueOnce({
        status: {
          readWriteAttachment: "",
          reconciling: false,
          lockState: undefined,
        },
      })
      .mockResolvedValueOnce({
        status: {
          readWriteAttachment: "",
          reconciling: false,
          lockState: undefined,
        },
      });

    const deletion = provider.deleteHost(
      {
        provider: "nebius",
        instance_id: "instance-1",
        ssh_user: "ubuntu",
        zone: "us-central1",
        metadata: {
          diskIds: {
            data: "data-disk",
            boot: "boot-disk",
          },
        },
      },
      {
        parentId: "project-1",
        serviceAccountId: "svc-1",
        publicKeyId: "pub-1",
        privateKeyPem: "key",
        sshPublicKey: "ssh-ed25519 AAAA",
        subnetId: "subnet-1",
      },
    );

    await jest.runOnlyPendingTimersAsync();
    await deletion;

    expect(instancesDeleteMock).toHaveBeenCalledTimes(1);
    expect(disksGetMock).toHaveBeenCalledTimes(3);
    expect(disksDeleteMock.mock.calls[0][0].id).toBe("data-disk");
    expect(disksDeleteMock.mock.calls[1][0].id).toBe("boot-disk");
  });

  it("preserves shared scratch when preserving the data disk", async () => {
    const provider = new NebiusProvider();
    disksGetMock.mockResolvedValue({
      status: {
        readWriteAttachment: "",
        reconciling: false,
        lockState: undefined,
      },
    });
    await provider.deleteHost(
      {
        provider: "nebius",
        instance_id: "instance-1",
        ssh_user: "ubuntu",
        zone: "us-central1",
        metadata: {
          diskIds: {
            data: "data-disk",
            boot: "boot-disk",
            scratch: "scratch-disk",
          },
        },
      },
      {
        parentId: "project-1",
        serviceAccountId: "svc-1",
        publicKeyId: "pub-1",
        privateKeyPem: "key",
        sshPublicKey: "ssh-ed25519 AAAA",
        subnetId: "subnet-1",
      },
      { preserveDataDisk: true },
    );

    expect(disksDeleteMock).toHaveBeenCalledTimes(1);
    expect(disksDeleteMock.mock.calls[0][0].id).toBe("boot-disk");
  });

  it("resizes shared scratch disks using the scratch disk type", async () => {
    const provider = new NebiusProvider();
    await provider.resizeSharedScratchDisk(
      {
        provider: "nebius",
        instance_id: "instance-1",
        ssh_user: "ubuntu",
        metadata: {
          diskIds: {
            scratch: "scratch-disk",
          },
          scratchDiskTypeCode: DiskSpec_DiskType.NETWORK_SSD_IO_M3.code,
        },
      },
      100,
      {
        parentId: "project-1",
        serviceAccountId: "svc-1",
        publicKeyId: "pub-1",
        privateKeyPem: "key",
        sshPublicKey: "ssh-ed25519 AAAA",
        subnetId: "subnet-1",
      },
    );

    expect(disksUpdateMock).toHaveBeenCalledTimes(1);
    expect(disksGetMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "scratch-disk" }),
    );
    expect(disksUpdateMock.mock.calls[0][0].metadata.id).toBe("scratch-disk");
    expect(disksUpdateMock.mock.calls[0][0].metadata.parentId).toBe(
      "project-1",
    );
    expect(disksUpdateMock.mock.calls[0][0].metadata.name).toBe("disk-name");
    expect(
      disksUpdateMock.mock.calls[0][0].metadata.resourceVersion.toNumber(),
    ).toBe(7);
    expect(
      disksUpdateMock.mock.calls[0][0].spec.size.sizeGibibytes.toNumber(),
    ).toBe(186);
  });

  it("resizes shared scratch disks using the persisted scratch disk name", async () => {
    disksGetMock
      .mockResolvedValueOnce({
        metadata: { id: "scratch-disk", parentId: "project-1" },
      })
      .mockResolvedValueOnce({
        metadata: { id: "scratch-disk", parentId: "project-1" },
        spec: {
          size: {
            $case: "sizeGibibytes",
            sizeGibibytes: 279,
          },
        },
      });
    const provider = new NebiusProvider();
    await provider.resizeSharedScratchDisk(
      {
        provider: "nebius",
        instance_id: "instance-1",
        ssh_user: "ubuntu",
        metadata: {
          diskIds: {
            scratch: "scratch-disk",
          },
          shared_disk_name: "spot-host-scratch",
          scratchDiskTypeCode: DiskSpec_DiskType.NETWORK_SSD.code,
        },
      },
      200,
      {
        parentId: "project-1",
        serviceAccountId: "svc-1",
        publicKeyId: "pub-1",
        privateKeyPem: "key",
        sshPublicKey: "ssh-ed25519 AAAA",
        subnetId: "subnet-1",
      },
    );

    expect(disksUpdateMock.mock.calls[0][0].metadata.id).toBe("scratch-disk");
    expect(disksUpdateMock.mock.calls[0][0].metadata.name).toBe(
      "spot-host-scratch",
    );
    expect(
      disksUpdateMock.mock.calls[0][0].spec.size.sizeGibibytes.toNumber(),
    ).toBe(279);
  });

  it("rejects shared scratch resize when provider size is unchanged", async () => {
    disksGetMock
      .mockResolvedValueOnce({
        metadata: {
          id: "scratch-disk",
          parentId: "project-1",
          name: "scratch-name",
        },
      })
      .mockResolvedValueOnce({
        metadata: {
          id: "scratch-disk",
          parentId: "project-1",
          name: "scratch-name",
        },
        spec: {
          size: {
            $case: "sizeGibibytes",
            sizeGibibytes: 93,
          },
        },
      });
    const provider = new NebiusProvider();
    await expect(
      provider.resizeSharedScratchDisk(
        {
          provider: "nebius",
          instance_id: "instance-1",
          ssh_user: "ubuntu",
          metadata: {
            diskIds: {
              scratch: "scratch-disk",
            },
            scratchDiskTypeCode: DiskSpec_DiskType.NETWORK_SSD.code,
          },
        },
        186,
        {
          parentId: "project-1",
          serviceAccountId: "svc-1",
          publicKeyId: "pub-1",
          privateKeyPem: "key",
          sshPublicKey: "ssh-ed25519 AAAA",
          subnetId: "subnet-1",
        },
      ),
    ).rejects.toThrow(/disk resize did not take effect/);
  });

  it("creates and attaches shared scratch to an existing instance", async () => {
    disksCreateMock.mockReset().mockResolvedValueOnce(diskOp("scratch-disk"));
    instancesGetMock.mockResolvedValue({
      metadata: {
        id: "instance-1",
        name: "spot-host",
      },
      spec: {
        serviceAccountId: "svc-1",
        secondaryDisks: [
          {
            deviceId: "data",
            type: {
              $case: "existingDisk",
              existingDisk: { id: "data-disk" },
            },
          },
        ],
      },
    });
    const provider = new NebiusProvider();
    const runtime = await provider.ensureSharedScratchDisk!(
      {
        provider: "nebius",
        instance_id: "instance-1",
        ssh_user: "ubuntu",
        metadata: {
          diskIds: {
            data: "data-disk",
          },
        },
      },
      buildSpec({
        shared_disk_gb: 500,
        shared_disk_type: "ssd",
      }),
      {
        parentId: "project-1",
        serviceAccountId: "svc-1",
        publicKeyId: "pub-1",
        privateKeyPem: "key",
        sshPublicKey: "ssh-ed25519 AAAA",
        subnetId: "subnet-1",
      },
    );

    expect(disksCreateMock).toHaveBeenCalledTimes(1);
    expect(instancesUpdateMock).toHaveBeenCalledTimes(1);
    const updateArgs = instancesUpdateMock.mock.calls[0][0];
    expect(updateArgs.metadata.id).toBe("instance-1");
    expect(updateArgs.metadata.name).toBe("spot-host");
    expect(
      updateArgs.spec.secondaryDisks.map((disk: any) => disk.deviceId),
    ).toEqual(["data", "scratch"]);
    expect(runtime.metadata).toMatchObject({
      diskIds: {
        data: "data-disk",
        scratch: "scratch-disk",
      },
      shared_disk_id: "scratch-disk",
      shared_disk_name: "spot-host-scratch",
    });
  });
});
