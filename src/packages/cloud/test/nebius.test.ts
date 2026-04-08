import { NebiusProvider } from "../nebius/provider";
import type { HostSpec } from "../types";
import { PreemptibleSpec_PreemptionPolicy } from "@nebius/js-sdk/api/nebius/compute/v1/index";

const disksCreateMock = jest.fn();
const disksListMock = jest.fn();
const instancesCreateMock = jest.fn();

jest.mock("../nebius/client", () => {
  class NebiusClient {
    readonly disks = {
      create: disksCreateMock,
      list: disksListMock,
    };
    readonly instances = {
      create: instancesCreateMock,
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
    disksCreateMock.mockReset();
    disksListMock.mockReset();
    instancesCreateMock.mockReset();
    disksListMock.mockResolvedValue({ items: [], nextPageToken: "" });
    disksCreateMock
      .mockResolvedValueOnce(diskOp("boot-disk"))
      .mockResolvedValueOnce(diskOp("data-disk"));
    instancesCreateMock.mockResolvedValue(instanceOp("instance-1"));
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
  });
});
