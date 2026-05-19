import { NebiusProvider } from "../nebius/provider";
import type { HostSpec } from "../types";
import {
  InstanceRecoveryPolicy,
  PreemptibleSpec_PreemptionPolicy,
} from "@nebius/js-sdk/api/nebius/compute/v1/index";

const disksCreateMock = jest.fn();
const disksListMock = jest.fn();
const disksGetMock = jest.fn();
const disksDeleteMock = jest.fn();
const instancesCreateMock = jest.fn();
const instancesDeleteMock = jest.fn();
const instancesGetMock = jest.fn();

jest.mock("../nebius/client", () => {
  class NebiusClient {
    readonly disks = {
      create: disksCreateMock,
      list: disksListMock,
      get: disksGetMock,
      delete: disksDeleteMock,
    };
    readonly instances = {
      create: instancesCreateMock,
      delete: instancesDeleteMock,
      get: instancesGetMock,
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
    instancesCreateMock.mockReset();
    instancesDeleteMock.mockReset();
    instancesGetMock.mockReset();
    disksListMock.mockResolvedValue({ items: [], nextPageToken: "" });
    disksCreateMock
      .mockResolvedValueOnce(diskOp("boot-disk"))
      .mockResolvedValueOnce(diskOp("data-disk"));
    instancesCreateMock.mockResolvedValue(instanceOp("instance-1"));
    instancesDeleteMock.mockResolvedValue(instanceOp("instance-1"));
    disksDeleteMock.mockResolvedValue(diskOp("deleted-disk"));
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
});
