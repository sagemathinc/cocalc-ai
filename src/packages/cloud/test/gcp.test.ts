import { GcpProvider } from "../gcp";
import type { HostSpec } from "../types";

const insertMock = jest.fn();
const getMock = jest.fn();
const getEffectiveFirewallsMock = jest.fn();
const diskGetMock = jest.fn();
const diskInsertMock = jest.fn();
const diskResizeMock = jest.fn();
const diskDeleteMock = jest.fn();
const attachDiskMock = jest.fn();
const detachDiskMock = jest.fn();
const setDiskAutoDeleteMock = jest.fn();
const startMock = jest.fn();
const stopMock = jest.fn();
const deleteMock = jest.fn();
const setSchedulingMock = jest.fn();
const setMachineTypeMock = jest.fn();
const setTagsMock = jest.fn();
const firewallGetMock = jest.fn();
const firewallListMock = jest.fn();
const firewallInsertMock = jest.fn();
const firewallPatchMock = jest.fn();
const authRequestMock = jest.fn();
const waitMock = jest.fn();
const globalWaitMock = jest.fn();

jest.mock("@google-cloud/compute", () => {
  class ImagesClient {
    get = getMock;
    getFromFamily = () => [{ selfLink: "/my/image" }];
    constructor(_opts?: any) {}
  }
  class DisksClient {
    get = diskGetMock;
    insert = diskInsertMock;
    resize = diskResizeMock;
    delete = diskDeleteMock;
    constructor(_opts?: any) {}
  }
  class InstancesClient {
    insert = insertMock;
    get = getMock;
    getEffectiveFirewalls = getEffectiveFirewallsMock;
    attachDisk = attachDiskMock;
    detachDisk = detachDiskMock;
    setDiskAutoDelete = setDiskAutoDeleteMock;
    start = startMock;
    stop = stopMock;
    delete = deleteMock;
    setScheduling = setSchedulingMock;
    setMachineType = setMachineTypeMock;
    setTags = setTagsMock;
    auth = {
      getClient: async () => ({
        request: authRequestMock,
      }),
    };
    constructor(_opts?: any) {}
  }
  class ZoneOperationsClient {
    wait = waitMock;
    constructor(_opts?: any) {}
  }
  class GlobalOperationsClient {
    wait = globalWaitMock;
    constructor(_opts?: any) {}
  }
  class FirewallsClient {
    get = firewallGetMock;
    list = firewallListMock;
    insert = firewallInsertMock;
    patch = firewallPatchMock;
    constructor(_opts?: any) {}
  }
  return {
    InstancesClient,
    ZoneOperationsClient,
    GlobalOperationsClient,
    FirewallsClient,
    ImagesClient,
    DisksClient,
  };
});

function buildSpec(overrides: Partial<HostSpec> = {}): HostSpec {
  return {
    name: "ph-test",
    region: "us-west1",
    cpu: 4,
    ram_gb: 8,
    disk_gb: 100,
    disk_type: "balanced",
    ...overrides,
  };
}

describe("GcpProvider", () => {
  beforeEach(() => {
    insertMock.mockReset();
    getMock.mockReset();
    getEffectiveFirewallsMock.mockReset();
    diskGetMock.mockReset();
    diskInsertMock.mockReset();
    diskResizeMock.mockReset();
    diskDeleteMock.mockReset();
    attachDiskMock.mockReset();
    detachDiskMock.mockReset();
    setDiskAutoDeleteMock.mockReset();
    startMock.mockReset();
    stopMock.mockReset();
    deleteMock.mockReset();
    setSchedulingMock.mockReset();
    setMachineTypeMock.mockReset();
    setTagsMock.mockReset();
    firewallGetMock.mockReset();
    firewallListMock.mockReset();
    firewallInsertMock.mockReset();
    firewallPatchMock.mockReset();
    authRequestMock.mockReset();
    waitMock.mockReset();
    globalWaitMock.mockReset();
  });

  it("restricts public ingress to the supplied ranges and preserves VM tags", async () => {
    firewallGetMock.mockRejectedValueOnce({ code: 404 }).mockResolvedValueOnce([
      {
        name: "cocalc-project-host-public-https",
        priority: 1000,
        sourceRanges: ["103.21.244.0/22", "173.245.48.0/20"],
        targetTags: ["cocalc-project-host-public-https"],
        allowed: [{ IPProtocol: "tcp", ports: ["443"] }],
      },
    ]);
    firewallListMock.mockResolvedValueOnce([
      [
        {
          name: "deny-project-host-ingress",
          priority: 900,
          direction: "INGRESS",
          sourceRanges: ["0.0.0.0/0"],
          targetTags: ["cocalc-project-host-public-https"],
          denied: [{ IPProtocol: "tcp" }],
        },
      ],
    ]);
    firewallInsertMock.mockResolvedValueOnce([
      { latestResponse: { name: "firewall-op", status: "DONE" } },
    ]);
    getMock.mockResolvedValueOnce([
      {
        networkInterfaces: [
          {
            name: "nic0",
            network: "projects/proj-1/global/networks/default",
            networkIP: "10.0.0.2",
            accessConfigs: [{ natIP: "203.0.113.20" }],
          },
        ],
        tags: {
          fingerprint: "tag-fingerprint",
          items: ["existing-tag"],
        },
      },
    ]);
    setTagsMock.mockResolvedValueOnce([
      { latestResponse: { name: "tags-op", status: "DONE" } },
    ]);
    getEffectiveFirewallsMock.mockResolvedValueOnce([
      {
        firewalls: [
          {
            name: "cocalc-project-host-public-https",
            priority: 1000,
            direction: "INGRESS",
            sourceRanges: ["103.21.244.0/22"],
            targetTags: ["cocalc-project-host-public-https"],
            allowed: [{ IPProtocol: "tcp", ports: ["443"] }],
          },
        ],
        firewallPolicys: [
          {
            name: "organizations/1/firewallPolicies/2",
            shortName: "org-policy",
            type: "HIERARCHY",
            rules: [
              {
                action: "goto_next",
                direction: "INGRESS",
                priority: 100,
                ruleName: "delegate-ingress",
                match: {
                  srcIpRanges: ["0.0.0.0/0"],
                  layer4Configs: [{ ipProtocol: "all" }],
                },
              },
            ],
          },
        ],
      },
    ]);

    const provider = new GcpProvider();
    const result = await provider.ensurePublicIngress(
      {
        provider: "gcp",
        instance_id: "ph-test",
        zone: "us-west1-a",
        ssh_user: "ubuntu",
      },
      {
        ports: [443],
        source_ranges: ["173.245.48.0/20", "103.21.244.0/22"],
      },
      {
        project_id: "proj-1",
        client_email: "svc@example.com",
        private_key: "key",
      },
    );

    expect(firewallInsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project: "proj-1",
        firewallResource: expect.objectContaining({
          allowed: [{ IPProtocol: "tcp", ports: ["443"] }],
          sourceRanges: ["103.21.244.0/22", "173.245.48.0/20"],
          targetTags: ["cocalc-project-host-public-https"],
        }),
      }),
    );
    expect(setTagsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tagsResource: {
          fingerprint: "tag-fingerprint",
          items: ["existing-tag", "cocalc-project-host-public-https"],
        },
      }),
    );
    expect(result).toEqual({
      instance: {
        network: "projects/proj-1/global/networks/default",
        network_interface: "nic0",
        public_ip: "203.0.113.20",
        private_ip: "10.0.0.2",
        tags: ["existing-tag", "cocalc-project-host-public-https"],
      },
      rule: {
        name: "cocalc-project-host-public-https",
        priority: 1000,
        source_ranges: ["103.21.244.0/22", "173.245.48.0/20"],
        target_tags: ["cocalc-project-host-public-https"],
        allowed: [{ IPProtocol: "tcp", ports: ["443"] }],
      },
      potential_conflicts: [
        {
          name: "deny-project-host-ingress",
          priority: 900,
          source_ranges: ["0.0.0.0/0"],
          target_tags: ["cocalc-project-host-public-https"],
          denied: [{ IPProtocol: "tcp" }],
        },
      ],
      effective_firewalls: {
        firewalls: [
          {
            name: "cocalc-project-host-public-https",
            priority: 1000,
            direction: "INGRESS",
            source_ranges: ["103.21.244.0/22"],
            target_tags: ["cocalc-project-host-public-https"],
            allowed: [{ IPProtocol: "tcp", ports: ["443"] }],
            denied: [],
          },
        ],
        policies: [
          {
            name: "organizations/1/firewallPolicies/2",
            short_name: "org-policy",
            type: "HIERARCHY",
            priority: undefined,
            rules: [
              {
                action: "goto_next",
                direction: "INGRESS",
                disabled: undefined,
                priority: 100,
                rule_name: "delegate-ingress",
                source_ranges: ["0.0.0.0/0"],
                destination_ranges: [],
                layer4_configs: [{ ipProtocol: "all" }],
                target_resources: [],
                target_service_accounts: [],
              },
            ],
          },
        ],
      },
    });
  });

  it("creates a host with boot + data disks and startup script", async () => {
    insertMock.mockResolvedValueOnce([
      { latestResponse: { name: "op-1", status: "DONE" } },
    ]);
    waitMock.mockResolvedValueOnce([{ status: "DONE" }]);
    getMock.mockResolvedValueOnce([
      {
        name: "ph-test",
        hostname: "ph-test.c.proj-1.internal",
        networkInterfaces: [
          {
            networkIP: "10.180.0.16",
            accessConfigs: [{ natIP: "203.0.113.10" }],
          },
        ],
      },
    ]);
    diskGetMock.mockRejectedValueOnce({ code: 404 });

    const provider = new GcpProvider();
    const spec = buildSpec({
      metadata: {
        bootstrap_url: "https://example.com/bootstrap.sh",
        instance_metadata: {
          "enable-windows-ssh": "TRUE",
          "windows-startup-script-ps1": "Write-Output ready",
        },
        subnetwork_uri:
          "projects/compute-proj/regions/us-west1/subnetworks/hostile-guests",
      },
    });
    const runtime = await provider.createHost(spec, {
      project_id: "proj-1",
      client_email: "svc@example.com",
      private_key: "key",
    });

    const insertArgs = insertMock.mock.calls[0][0];
    const disks = insertArgs.instanceResource.disks;
    expect(disks).toHaveLength(2);
    expect(
      insertArgs.instanceResource.networkInterfaces[0].accessConfigs[0]
        .networkTier,
    ).toBe("STANDARD");
    expect(insertArgs.instanceResource.networkInterfaces[0].subnetwork).toBe(
      "projects/compute-proj/regions/us-west1/subnetworks/hostile-guests",
    );
    expect(disks[0].boot).toBe(true);
    expect(disks[0].initializeParams.diskSizeGb).toBe("10");
    expect(disks[1].boot).toBe(false);
    expect(disks[1].initializeParams.diskSizeGb).toBe("100");
    expect(
      insertArgs.instanceResource.metadata.items.find(
        (item: any) => item.key === "startup-script",
      )?.value,
    ).toContain("bootstrap.sh");
    expect(
      insertArgs.instanceResource.metadata.items.find(
        (item: any) => item.key === "windows-startup-script-ps1",
      )?.value,
    ).toBe("Write-Output ready");

    expect(runtime.public_ip).toBe("203.0.113.10");
    expect(runtime.private_ip).toBe("10.180.0.16");
    expect(runtime.internal_hostname).toBe("ph-test.c.proj-1.internal");
    expect(runtime.instance_id).toBe("ph-test");
  });

  it("adds GPU accelerator when configured", async () => {
    insertMock.mockResolvedValueOnce([
      { latestResponse: { name: "op-2", status: "DONE" } },
    ]);
    waitMock.mockResolvedValueOnce([{ status: "DONE" }]);
    getMock.mockResolvedValueOnce([{ networkInterfaces: [] }]);
    diskGetMock.mockRejectedValueOnce({ code: 404 });

    const provider = new GcpProvider();
    const spec = buildSpec({
      gpu: { type: "nvidia-tesla-t4", count: 1 },
    });
    await provider.createHost(spec, {
      project_id: "proj-1",
      client_email: "svc@example.com",
      private_key: "key",
    });

    const insertArgs = insertMock.mock.calls[0][0];
    expect(insertArgs.instanceResource.guestAccelerators).toHaveLength(1);
    expect(
      insertArgs.instanceResource.guestAccelerators[0].acceleratorType,
    ).toContain("nvidia-tesla-t4");
    expect(insertArgs.instanceResource.scheduling?.onHostMaintenance).toBe(
      "TERMINATE",
    );
  });

  it("uses the GPUs integrated into a G2 machine without reattaching them", async () => {
    insertMock.mockResolvedValueOnce([
      { latestResponse: { name: "op-g2", status: "DONE" } },
    ]);
    waitMock.mockResolvedValueOnce([{ status: "DONE" }]);
    getMock.mockResolvedValueOnce([{ networkInterfaces: [] }]);
    diskGetMock.mockRejectedValueOnce({ code: 404 });

    const provider = new GcpProvider();
    await provider.createHost(
      buildSpec({
        gpu: { type: "nvidia-l4", count: 1 },
        metadata: { machine_type: "g2-standard-4" },
      }),
      {
        project_id: "proj-1",
        client_email: "svc@example.com",
        private_key: "key",
      },
    );

    const instance = insertMock.mock.calls[0][0].instanceResource;
    expect(instance.guestAccelerators).toEqual([]);
    expect(instance.scheduling?.onHostMaintenance).toBe("TERMINATE");
  });

  it("creates a host with a shared scratch disk", async () => {
    insertMock.mockResolvedValueOnce([
      { latestResponse: { name: "op-scratch", status: "DONE" } },
    ]);
    waitMock.mockResolvedValueOnce([{ status: "DONE" }]);
    getMock.mockResolvedValueOnce([
      {
        name: "ph-test",
        hostname: "ph-test.c.proj-1.internal",
        disks: [
          {
            boot: false,
            deviceName: "ph-test-data",
            source: "projects/proj-1/zones/us-west1-a/disks/ph-test-data",
          },
          {
            boot: false,
            deviceName: "ph-test-scratch",
            source: "projects/proj-1/zones/us-west1-a/disks/ph-test-scratch",
          },
        ],
        networkInterfaces: [
          {
            networkIP: "10.180.0.19",
            accessConfigs: [{ natIP: "203.0.113.13" }],
          },
        ],
      },
    ]);
    diskGetMock.mockRejectedValue({ code: 404 });

    const provider = new GcpProvider();
    const runtime = await provider.createHost(
      buildSpec({
        shared_disk_gb: 500,
        shared_disk_type: "balanced",
      }),
      {
        project_id: "proj-1",
        client_email: "svc@example.com",
        private_key: "key",
      },
    );

    const disks = insertMock.mock.calls[0][0].instanceResource.disks;
    expect(disks).toHaveLength(3);
    expect(disks[2]).toMatchObject({
      autoDelete: false,
      boot: false,
      deviceName: "ph-test-scratch",
      initializeParams: {
        diskName: "ph-test-scratch",
        diskSizeGb: "500",
        diskType: expect.stringContaining("/diskTypes/pd-balanced"),
      },
    });
    expect(runtime.metadata).toMatchObject({
      data_disk_name: "ph-test-data",
      shared_disk_gb: 500,
      shared_disk_type: "balanced",
      shared_disk_id: "ph-test-scratch",
      shared_disk_name: "ph-test-scratch",
      shared_disk_uri: "projects/proj-1/zones/us-west1-a/disks/ph-test-scratch",
    });
  });

  it("creates spot instances with spot scheduling", async () => {
    insertMock.mockResolvedValueOnce([
      { latestResponse: { name: "op-spot", status: "DONE" } },
    ]);
    waitMock.mockResolvedValueOnce([{ status: "DONE" }]);
    getMock.mockResolvedValueOnce([{ networkInterfaces: [] }]);
    diskGetMock.mockRejectedValueOnce({ code: 404 });

    const provider = new GcpProvider();
    await provider.createHost(
      buildSpec({
        pricing_model: "spot",
      }),
      {
        project_id: "proj-1",
        client_email: "svc@example.com",
        private_key: "key",
      },
    );

    const scheduling = insertMock.mock.calls[0][0].instanceResource.scheduling;
    expect(scheduling).toMatchObject({
      onHostMaintenance: "TERMINATE",
      automaticRestart: false,
      preemptible: true,
      provisioningModel: "SPOT",
      instanceTerminationAction: "STOP",
    });
  });

  it("creates a hostile-guest VM with a persistent boot-only disk", async () => {
    insertMock.mockResolvedValueOnce([
      { latestResponse: { name: "op-compute", status: "DONE" } },
    ]);
    diskGetMock.mockRejectedValueOnce({ code: 404 });
    getMock.mockResolvedValueOnce([
      {
        name: "ph-test",
        disks: [
          {
            boot: true,
            deviceName: "ph-test-boot",
            source: "projects/proj-1/zones/us-west1-a/disks/ph-test-boot",
          },
        ],
        networkInterfaces: [],
      },
    ]);

    const provider = new GcpProvider();
    const runtime = await provider.createHost(
      buildSpec({
        metadata: {
          storage_mode: "boot-only",
          persistent_boot_disk: true,
          boot_disk_name: "ph-test-boot",
          disable_service_account: true,
          block_project_ssh_keys: true,
          ssh_public_key: "ssh-ed25519 AAAATEST owner",
          labels: { "managed-by": "cocalc-compute" },
        },
      }),
      {
        project_id: "proj-1",
        client_email: "svc@example.com",
        private_key: "key",
      },
    );

    const resource = insertMock.mock.calls[0][0].instanceResource;
    expect(resource.disks).toHaveLength(1);
    expect(resource.disks[0]).toMatchObject({
      autoDelete: false,
      boot: true,
      deviceName: "ph-test-boot",
      initializeParams: { diskName: "ph-test-boot" },
    });
    expect(resource.serviceAccounts).toEqual([]);
    expect(resource.canIpForward).toBe(false);
    expect(resource.deletionProtection).toBe(false);
    expect(resource.labels).toEqual({ "managed-by": "cocalc-compute" });
    expect(resource.metadata.items).toEqual(
      expect.arrayContaining([
        { key: "block-project-ssh-keys", value: "TRUE" },
      ]),
    );
    expect(runtime.metadata).toMatchObject({
      persistent_boot_disk: true,
      boot_disk_name: "ph-test-boot",
    });
  });

  it("recovers a created host when insert times out after GCP accepts it", async () => {
    insertMock.mockRejectedValueOnce(
      Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT" }),
    );
    getMock.mockResolvedValueOnce([
      {
        status: "RUNNING",
        hostname: "ph-test.c.proj-1.internal",
        networkInterfaces: [
          {
            networkIP: "10.180.0.17",
            accessConfigs: [{ natIP: "203.0.113.11" }],
          },
        ],
      },
    ]);
    diskGetMock.mockRejectedValueOnce({ code: 404 });

    const provider = new GcpProvider();
    const runtime = await provider.createHost(buildSpec(), {
      project_id: "proj-1",
      client_email: "svc@example.com",
      private_key: "key",
    });

    expect(runtime).toMatchObject({
      provider: "gcp",
      instance_id: "ph-test",
      public_ip: "203.0.113.11",
      private_ip: "10.180.0.17",
      internal_hostname: "ph-test.c.proj-1.internal",
      zone: "us-west1-a",
      metadata: {
        gcp_project_id: "proj-1",
        provider_status: "RUNNING",
      },
    });
    expect(waitMock).not.toHaveBeenCalled();
  });

  it("treats already-existing GCP instances as idempotent create recovery", async () => {
    insertMock.mockRejectedValueOnce({
      code: 409,
      message: "The resource already exists",
      errors: [{ reason: "alreadyExists" }],
    });
    getMock.mockResolvedValueOnce([
      {
        status: "PROVISIONING",
        hostname: "ph-test.c.proj-1.internal",
        networkInterfaces: [
          {
            networkIP: "10.180.0.18",
            accessConfigs: [{ natIP: "203.0.113.12" }],
          },
        ],
      },
    ]);
    diskGetMock.mockRejectedValueOnce({ code: 404 });

    const provider = new GcpProvider();
    const runtime = await provider.createHost(buildSpec(), {
      project_id: "proj-1",
      client_email: "svc@example.com",
      private_key: "key",
    });

    expect(runtime.public_ip).toBe("203.0.113.12");
    expect(runtime.private_ip).toBe("10.180.0.18");
    expect(runtime.internal_hostname).toBe("ph-test.c.proj-1.internal");
    expect(runtime.metadata?.provider_status).toBe("PROVISIONING");
  });

  it("starts, stops, and deletes a host", async () => {
    getMock.mockResolvedValueOnce([{ status: "TERMINATED" }]);
    startMock.mockResolvedValueOnce([{}]);
    stopMock.mockResolvedValueOnce([{}]);
    deleteMock.mockResolvedValueOnce([{}]);

    const provider = new GcpProvider();
    const runtime = {
      provider: "gcp" as const,
      instance_id: "ph-test",
      zone: "us-west1-b",
      ssh_user: "ubuntu",
    };
    const creds = {
      project_id: "proj-1",
      client_email: "svc@example.com",
      private_key: "key",
    };
    await provider.startHost(runtime, creds);
    await provider.stopHost(runtime, creds);
    await provider.deleteHost(runtime, creds);

    expect(startMock).toHaveBeenCalledWith({
      project: "proj-1",
      zone: "us-west1-b",
      instance: "ph-test",
    });
    expect(stopMock).toHaveBeenCalledWith({
      project: "proj-1",
      zone: "us-west1-b",
      instance: "ph-test",
    });
    expect(deleteMock).toHaveBeenCalledWith({
      project: "proj-1",
      zone: "us-west1-b",
      instance: "ph-test",
    });
  });

  it("preserves shared scratch when preserving the data disk", async () => {
    getMock.mockResolvedValueOnce([
      {
        disks: [
          { boot: false, deviceName: "ph-test-data" },
          { boot: false, deviceName: "ph-test-scratch" },
        ],
      },
    ]);
    deleteMock.mockResolvedValueOnce([{}]);

    const provider = new GcpProvider();
    await provider.deleteHost(
      {
        provider: "gcp",
        instance_id: "ph-test",
        zone: "us-west1-b",
        ssh_user: "ubuntu",
        metadata: { shared_disk_name: "ph-test-scratch" },
      },
      {
        project_id: "proj-1",
        client_email: "svc@example.com",
        private_key: "key",
      },
      { preserveDataDisk: true },
    );

    expect(setDiskAutoDeleteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceName: "ph-test-data",
        autoDelete: false,
      }),
    );
    expect(setDiskAutoDeleteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceName: "ph-test-scratch",
        autoDelete: false,
      }),
    );
    expect(diskDeleteMock).not.toHaveBeenCalled();
  });

  it("creates and attaches shared scratch to an existing instance", async () => {
    diskGetMock.mockRejectedValueOnce({ code: 404 }).mockResolvedValueOnce([
      {
        selfLink: "projects/proj-1/zones/us-west1-a/disks/ph-test-scratch",
      },
    ]);
    diskInsertMock.mockResolvedValueOnce([
      { latestResponse: { name: "op-create-scratch", status: "DONE" } },
    ]);
    getMock.mockResolvedValueOnce([{ disks: [] }]);
    attachDiskMock.mockResolvedValueOnce([
      { latestResponse: { name: "op-attach-scratch", status: "DONE" } },
    ]);
    waitMock
      .mockResolvedValueOnce([{ status: "DONE" }])
      .mockResolvedValueOnce([{ status: "DONE" }]);

    const provider = new GcpProvider();
    const runtime = await provider.ensureSharedScratchDisk!(
      {
        provider: "gcp",
        instance_id: "ph-test",
        zone: "us-west1-a",
        ssh_user: "ubuntu",
        metadata: {},
      },
      buildSpec({
        shared_disk_gb: 250,
        shared_disk_type: "ssd",
      }),
      {
        project_id: "proj-1",
        client_email: "svc@example.com",
        private_key: "key",
      },
    );

    expect(diskInsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        diskResource: expect.objectContaining({
          name: "ph-test-scratch",
          sizeGb: "250",
          type: expect.stringContaining("/diskTypes/pd-ssd"),
        }),
      }),
    );
    expect(attachDiskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        attachedDiskResource: expect.objectContaining({
          deviceName: "ph-test-scratch",
          autoDelete: false,
        }),
      }),
    );
    expect(runtime.metadata).toMatchObject({
      shared_disk_id: "ph-test-scratch",
      shared_disk_name: "ph-test-scratch",
      shared_disk_gb: 250,
      shared_disk_type: "ssd",
    });
  });

  it("resizes and deletes shared scratch disks", async () => {
    diskResizeMock.mockResolvedValueOnce([
      { latestResponse: { name: "op-resize-scratch", status: "DONE" } },
    ]);
    getMock.mockResolvedValueOnce([
      { disks: [{ boot: false, deviceName: "ph-test-scratch" }] },
    ]);
    detachDiskMock.mockResolvedValueOnce([
      { latestResponse: { name: "op-detach-scratch", status: "DONE" } },
    ]);
    diskDeleteMock.mockResolvedValueOnce([
      { latestResponse: { name: "op-delete-scratch", status: "DONE" } },
    ]);
    waitMock
      .mockResolvedValueOnce([{ status: "DONE" }])
      .mockResolvedValueOnce([{ status: "DONE" }])
      .mockResolvedValueOnce([{ status: "DONE" }]);

    const provider = new GcpProvider();
    const runtime = {
      provider: "gcp" as const,
      instance_id: "ph-test",
      zone: "us-west1-a",
      ssh_user: "ubuntu",
      metadata: { shared_disk_name: "ph-test-scratch" },
    };
    const creds = {
      project_id: "proj-1",
      client_email: "svc@example.com",
      private_key: "key",
    };
    await provider.resizeSharedScratchDisk!(runtime, 500, creds);
    await provider.deleteSharedScratchDisk!(runtime, creds);

    expect(diskResizeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        disk: "ph-test-scratch",
        disksResizeRequestResource: { sizeGb: 500 },
      }),
    );
    expect(detachDiskMock).toHaveBeenCalledWith(
      expect.objectContaining({ deviceName: "ph-test-scratch" }),
    );
    expect(diskDeleteMock).toHaveBeenCalledWith(
      expect.objectContaining({ disk: "ph-test-scratch" }),
    );
  });

  it("treats start as a no-op when the instance is already running", async () => {
    getMock.mockResolvedValueOnce([{ status: "RUNNING" }]);

    const provider = new GcpProvider();
    await provider.startHost(
      {
        provider: "gcp",
        instance_id: "ph-test",
        zone: "us-west1-a",
        ssh_user: "ubuntu",
      },
      {
        project_id: "proj-1",
        client_email: "svc@example.com",
        private_key: "key",
      },
    );

    expect(startMock).not.toHaveBeenCalled();
  });

  it("changes scheduling when switching pricing models", async () => {
    getMock.mockResolvedValueOnce([
      {
        status: "TERMINATED",
        scheduling: {
          preemptible: true,
          provisioningModel: "SPOT",
        },
      },
    ]);
    authRequestMock.mockResolvedValueOnce({
      data: { name: "op-scheduling", status: "DONE" },
    });
    waitMock.mockResolvedValueOnce([{ status: "DONE" }]);

    const provider = new GcpProvider();
    await provider.setPricingModel?.(
      {
        provider: "gcp",
        instance_id: "ph-test",
        zone: "us-west1-a",
        ssh_user: "ubuntu",
        metadata: { gpu_count: 0 },
      },
      "on_demand",
      {
        project_id: "proj-1",
        client_email: "svc@example.com",
        private_key: "key",
      },
    );

    expect(authRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        url: expect.stringContaining(
          "/projects/proj-1/zones/us-west1-a/instances/ph-test/setScheduling",
        ),
        data: expect.objectContaining({
          provisioningModel: "STANDARD",
          automaticRestart: true,
          instanceTerminationAction: null,
        }),
      }),
    );
    expect(setSchedulingMock).not.toHaveBeenCalled();
  });

  it("stops a running instance before changing pricing models", async () => {
    getMock
      .mockResolvedValueOnce([
        {
          status: "RUNNING",
          scheduling: {
            preemptible: true,
            provisioningModel: "SPOT",
          },
        },
      ])
      .mockResolvedValueOnce([{ status: "TERMINATED" }]);
    stopMock.mockResolvedValueOnce([
      { latestResponse: { name: "op-stop", status: "DONE" } },
    ]);
    authRequestMock.mockResolvedValueOnce({
      data: { name: "op-scheduling", status: "DONE" },
    });
    waitMock
      .mockResolvedValueOnce([{ status: "DONE" }])
      .mockResolvedValueOnce([{ status: "DONE" }]);

    const provider = new GcpProvider();
    await provider.setPricingModel?.(
      {
        provider: "gcp",
        instance_id: "ph-test",
        zone: "us-west1-a",
        ssh_user: "ubuntu",
        metadata: { gpu_count: 0 },
      },
      "on_demand",
      {
        project_id: "proj-1",
        client_email: "svc@example.com",
        private_key: "key",
      },
    );

    expect(stopMock).toHaveBeenCalledWith({
      project: "proj-1",
      zone: "us-west1-a",
      instance: "ph-test",
    });
    expect(authRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        url: expect.stringContaining(
          "/projects/proj-1/zones/us-west1-a/instances/ph-test/setScheduling",
        ),
      }),
    );
  });

  it("changes the machine type of a stopped instance", async () => {
    getMock.mockResolvedValueOnce([
      {
        status: "TERMINATED",
        machineType: "zones/us-west1-a/machineTypes/t2d-standard-16",
      },
    ]);
    setMachineTypeMock.mockResolvedValueOnce([
      { latestResponse: { name: "op-machine-type", status: "DONE" } },
    ]);
    waitMock.mockResolvedValueOnce([{ status: "DONE" }]);

    const provider = new GcpProvider();
    await provider.setMachineType?.(
      {
        provider: "gcp",
        instance_id: "ph-test",
        zone: "us-west1-a",
        ssh_user: "ubuntu",
      },
      "n2d-standard-16",
      {
        project_id: "proj-1",
        client_email: "svc@example.com",
        private_key: "key",
      },
    );

    expect(setMachineTypeMock).toHaveBeenCalledWith({
      project: "proj-1",
      zone: "us-west1-a",
      instance: "ph-test",
      instancesSetMachineTypeRequestResource: {
        machineType: "zones/us-west1-a/machineTypes/n2d-standard-16",
      },
    });
  });

  it("probes same-shape spot availability with a temporary instance", async () => {
    insertMock.mockResolvedValueOnce([
      { latestResponse: { name: "op-probe-create", status: "DONE" } },
    ]);
    deleteMock.mockResolvedValueOnce([
      { latestResponse: { name: "op-probe-delete", status: "DONE" } },
    ]);
    waitMock
      .mockResolvedValueOnce([{ status: "DONE" }])
      .mockResolvedValueOnce([{ status: "DONE" }]);

    const provider = new GcpProvider();
    const available = await provider.probeSpotAvailability?.(
      buildSpec({
        zone: "us-west1-a",
        pricing_model: "spot",
        metadata: {
          subnetwork_uri:
            "projects/compute-proj/regions/us-west1/subnetworks/hostile-guests",
        },
      }),
      {
        project_id: "proj-1",
        client_email: "svc@example.com",
        private_key: "key",
      },
    );

    expect(available).toBe(true);
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        zone: "us-west1-a",
        instanceResource: expect.objectContaining({
          networkInterfaces: [
            expect.objectContaining({
              subnetwork:
                "projects/compute-proj/regions/us-west1/subnetworks/hostile-guests",
              accessConfigs: [
                expect.objectContaining({
                  networkTier: "STANDARD",
                }),
              ],
            }),
          ],
          scheduling: expect.objectContaining({
            provisioningModel: "SPOT",
          }),
        }),
      }),
    );
    expect(deleteMock).toHaveBeenCalled();
  });

  it("throws when start operation completes with an error", async () => {
    getMock.mockResolvedValueOnce([{ status: "TERMINATED" }]);
    startMock.mockResolvedValueOnce([
      { latestResponse: { name: "op-start", status: "PENDING" } },
    ]);
    waitMock.mockResolvedValueOnce([
      {
        status: "DONE",
        error: {
          errors: [
            {
              code: "RESOURCE_NOT_READY",
              message: "instance is not ready to start",
            },
          ],
        },
      },
    ]);

    const provider = new GcpProvider();
    const runtime = {
      provider: "gcp" as const,
      instance_id: "ph-test",
      zone: "us-west1-b",
      ssh_user: "ubuntu",
    };
    const creds = {
      project_id: "proj-1",
      client_email: "svc@example.com",
      private_key: "key",
    };

    await expect(provider.startHost(runtime, creds)).rejects.toThrow(
      "RESOURCE_NOT_READY",
    );
  });

  it("retries transient operation wait timeouts during stop", async () => {
    stopMock.mockResolvedValueOnce([
      { latestResponse: { name: "op-stop", status: "PENDING" } },
    ]);
    waitMock
      .mockRejectedValueOnce(
        Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT" }),
      )
      .mockResolvedValueOnce([{ status: "DONE" }]);

    const provider = new GcpProvider();
    const runtime = {
      provider: "gcp" as const,
      instance_id: "ph-test",
      zone: "us-west1-b",
      ssh_user: "ubuntu",
    };
    const creds = {
      project_id: "proj-1",
      client_email: "svc@example.com",
      private_key: "key",
    };

    await provider.stopHost(runtime, creds);

    expect(waitMock).toHaveBeenCalledTimes(2);
  });

  it("respects custom zone and source image", async () => {
    insertMock.mockResolvedValueOnce([
      { latestResponse: { name: "op-3", status: "DONE" } },
    ]);
    waitMock.mockResolvedValueOnce([{ status: "DONE" }]);
    getMock.mockResolvedValueOnce([{ networkInterfaces: [] }]);
    diskGetMock.mockRejectedValueOnce({ code: 404 });

    const provider = new GcpProvider();
    const spec = buildSpec({
      region: "us-east1",
      zone: "us-east1-b",
      metadata: {
        source_image: "projects/custom/global/images/custom-image",
      },
    });
    await provider.createHost(spec, {
      project_id: "proj-1",
      client_email: "svc@example.com",
      private_key: "key",
    });

    const insertArgs = insertMock.mock.calls[0][0];
    expect(insertArgs.zone).toBe("us-east1-b");
    expect(
      insertArgs.instanceResource.disks[0].initializeParams.sourceImage,
    ).toBe("projects/custom/global/images/custom-image");
    expect(insertArgs.instanceResource.machineType).toContain("us-east1-b");
  });

  it("reports observed hostile-guest security settings", async () => {
    getMock.mockResolvedValueOnce([
      {
        name: "compute-vm",
        machineType: "zones/us-central1-a/machineTypes/e2-standard-4",
        status: "RUNNING",
        canIpForward: false,
        deletionProtection: false,
        serviceAccounts: [],
        tags: { items: ["cocalc-compute-vm"] },
        metadata: {
          items: [{ key: "block-project-ssh-keys", value: "TRUE" }],
        },
        networkInterfaces: [
          {
            subnetwork:
              "projects/compute-prod/regions/us-central1/subnetworks/hostile-guests",
            accessConfigs: [{ natIP: "203.0.113.10", networkTier: "STANDARD" }],
            ipv6AccessConfigs: [],
          },
        ],
      },
    ]);
    const provider = new GcpProvider();
    const observed = await provider.getInstance(
      {
        provider: "gcp",
        instance_id: "compute-vm",
        zone: "us-central1-a",
        ssh_user: "ubuntu",
      },
      {
        project_id: "compute-prod",
        client_email: "svc@example.com",
        private_key: "key",
      },
    );
    expect(observed?.metadata?.gcp_security).toEqual({
      service_account_count: 0,
      can_ip_forward: false,
      deletion_protection: false,
      block_project_ssh_keys: true,
      tags: ["cocalc-compute-vm"],
      subnetwork:
        "projects/compute-prod/regions/us-central1/subnetworks/hostile-guests",
      network_tier: "STANDARD",
      external_access_config_count: 1,
      external_ipv6: false,
    });
    expect(observed?.metadata).toMatchObject({
      machine_type: "e2-standard-4",
      provider_status: "RUNNING",
    });
  });

  it("creates labeled persistent compute volumes idempotently", async () => {
    diskGetMock.mockRejectedValueOnce({ code: 404 }).mockResolvedValueOnce([
      {
        selfLink:
          "projects/compute-prod/zones/us-central1-a/disks/cocalc-vol-1",
        sizeGb: "50",
        users: [],
      },
    ]);
    diskInsertMock.mockResolvedValueOnce([
      { latestResponse: { name: "disk-op", status: "DONE" } },
    ]);
    waitMock.mockResolvedValueOnce([{ status: "DONE" }]);
    const provider = new GcpProvider();
    const observed = await provider.ensurePersistentDisk(
      {
        name: "cocalc-vol-1",
        zone: "us-central1-a",
        size_gb: 50,
        disk_type: "balanced",
        labels: { "managed-by": "cocalc-compute" },
      },
      {
        project_id: "compute-prod",
        client_email: "compute@example.invalid",
        private_key: "key",
      },
    );
    expect(diskInsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        diskResource: expect.objectContaining({
          name: "cocalc-vol-1",
          sizeGb: "50",
          labels: { "managed-by": "cocalc-compute" },
        }),
      }),
    );
    expect(observed).toMatchObject({ size_gb: 50, users: [] });
  });

  it("treats a concurrent persistent-disk insert as success", async () => {
    diskGetMock
      .mockRejectedValueOnce({ code: 404 })
      .mockResolvedValueOnce([{ sizeGb: "20", users: [] }]);
    diskInsertMock.mockRejectedValueOnce({ code: 409 });
    const provider = new GcpProvider();
    await expect(
      provider.ensurePersistentDisk(
        {
          name: "cocalc-vol-race",
          zone: "us-central1-a",
          size_gb: 20,
          disk_type: "balanced",
        },
        {
          project_id: "compute-prod",
          client_email: "compute@example.invalid",
          private_key: "key",
        },
      ),
    ).resolves.toMatchObject({ name: "cocalc-vol-race", size_gb: 20 });
  });

  it("refuses to delete an attached persistent compute volume", async () => {
    diskGetMock.mockResolvedValueOnce([
      {
        sizeGb: "20",
        users: [
          "projects/compute-prod/zones/us-central1-a/instances/compute-vm",
        ],
      },
    ]);
    const provider = new GcpProvider();
    await expect(
      provider.deletePersistentDisk(
        { name: "cocalc-vol-1", zone: "us-central1-a" },
        {
          project_id: "compute-prod",
          client_email: "compute@example.invalid",
          private_key: "key",
        },
      ),
    ).rejects.toThrow("refusing to delete attached disk");
    expect(diskDeleteMock).not.toHaveBeenCalled();
  });
});
