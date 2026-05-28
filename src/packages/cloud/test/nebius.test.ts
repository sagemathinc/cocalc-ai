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
const instancesUpdateMock = jest.fn();

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
      update: instancesUpdateMock,
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
    instancesUpdateMock.mockReset();
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
    instancesDeleteMock.mockResolvedValue(instanceOp("instance-1"));
    instancesUpdateMock.mockResolvedValue(instanceOp("instance-1"));
    disksDeleteMock.mockResolvedValue(diskOp("deleted-disk"));
    disksUpdateMock.mockResolvedValue(diskOp("updated-disk"));
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
