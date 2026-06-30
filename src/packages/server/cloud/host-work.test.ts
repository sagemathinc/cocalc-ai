import { upsertProjectHost } from "@cocalc/database/postgres/project-hosts";
import {
  ensureProjectHostRuntimeDeploymentsSchema,
  listProjectHostRuntimeDeployments,
  setProjectHostRuntimeDeployments,
} from "@cocalc/database/postgres/project-host-runtime-deployments";
import { after, before, getPool } from "@cocalc/server/test";

const provisionIfNeededMock = jest.fn();
const getProviderContextMock = jest.fn();
const buildCloudInitStartupScriptMock = jest.fn();
const resolveLaunchpadBootstrapUrlMock = jest.fn();
const createProjectHostBootstrapTokenMock = jest.fn();
const restoreProjectHostTokensForRestartMock = jest.fn();
const getServerSettingsMock = jest.fn();
const getRoutedHostControlClientMock = jest.fn();
const maybeAutoGrowHostDiskForReservationFailureMock = jest.fn();
const removeHostSshKnownHostAliasMock = jest.fn();

jest.mock("./host-util", () => ({
  provisionIfNeeded: (...args: any[]) => provisionIfNeededMock(...args),
}));

jest.mock("./provider-context", () => ({
  getProviderContext: (...args: any[]) => getProviderContextMock(...args),
}));

jest.mock("./bootstrap-host", () => ({
  buildCloudInitStartupScript: (...args: any[]) =>
    buildCloudInitStartupScriptMock(...args),
  handleBootstrap: jest.fn(),
}));

jest.mock("@cocalc/server/launchpad/bootstrap-url", () => ({
  resolveLaunchpadBootstrapUrl: (...args: any[]) =>
    resolveLaunchpadBootstrapUrlMock(...args),
}));

jest.mock("@cocalc/server/project-host/bootstrap-token", () => ({
  createProjectHostBootstrapToken: (...args: any[]) =>
    createProjectHostBootstrapTokenMock(...args),
  revokeProjectHostTokensForHost: jest.fn(),
  restoreProjectHostTokensForRestart: (...args: any[]) =>
    restoreProjectHostTokensForRestartMock(...args),
}));

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: (...args: any[]) => getServerSettingsMock(...args),
}));

jest.mock("@cocalc/server/project-host/client", () => ({
  getRoutedHostControlClient: (...args: any[]) =>
    getRoutedHostControlClientMock(...args),
}));

jest.mock("@cocalc/server/project-host/auto-grow", () => ({
  maybeAutoGrowHostDiskForReservationFailure: (...args: any[]) =>
    maybeAutoGrowHostDiskForReservationFailureMock(...args),
}));

jest.mock("./host-ssh-known-hosts", () => ({
  removeHostSshKnownHostAlias: (...args: any[]) =>
    removeHostSshKnownHostAliasMock(...args),
}));

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);

afterAll(after);

beforeEach(async () => {
  jest.clearAllMocks();
  await getPool().query("DELETE FROM cloud_vm_log");
  await getPool().query("DELETE FROM cloud_vm_work");
  await getPool().query(
    "DELETE FROM rootfs_images WHERE image_id LIKE 'test-prepull-%'",
  );
  await ensureProjectHostRuntimeDeploymentsSchema();
  await getPool().query("DELETE FROM project_host_runtime_deployments");
  await getPool().query("DELETE FROM project_hosts");
  buildCloudInitStartupScriptMock.mockResolvedValue("#!/bin/bash\necho ok\n");
  resolveLaunchpadBootstrapUrlMock.mockResolvedValue({
    baseUrl: "https://dev.example.test",
  });
  createProjectHostBootstrapTokenMock.mockResolvedValue({
    token: "bootstrap-token",
  });
  restoreProjectHostTokensForRestartMock.mockResolvedValue({
    restored: [],
  });
  getServerSettingsMock.mockResolvedValue({
    dns: "launchpad.example.test",
  });
  getRoutedHostControlClientMock.mockResolvedValue({
    pullRootfsImage: jest.fn(async () => ({})),
  });
  maybeAutoGrowHostDiskForReservationFailureMock.mockResolvedValue({
    grown: false,
    reason: "not a reservation failure",
  });
  removeHostSshKnownHostAliasMock.mockResolvedValue(undefined);
  getProviderContextMock.mockResolvedValue({
    entry: {
      provider: {
        deleteHost: jest.fn(async () => undefined),
      },
    },
    creds: {},
  });
});

describe("cloud host start failures", () => {
  it("does not resurrect stale runtime metadata after reprovision start fails", async () => {
    const hostId = "2058bae4-d049-40b9-88ba-187a7091da55";
    const quotaError = new Error(
      "QUOTA_EXCEEDED: Quota 'CPUS_PER_VM_FAMILY' exceeded.",
    );
    provisionIfNeededMock.mockRejectedValue(quotaError);

    await upsertProjectHost({
      id: hostId,
      name: "Quota host",
      region: "us-west1",
      status: "starting",
      public_url: "http://136.109.220.184",
      internal_url: "http://136.109.220.184",
      metadata: {
        owner: "acct-owner",
        size: "c3d-highcpu-8",
        machine: {
          cloud: "gcp",
          zone: "us-west1-a",
          machine_type: "c3d-highcpu-8",
          disk_gb: 100,
          disk_type: "ssd",
          storage_mode: "persistent",
          metadata: {
            data_disk_name: `cocalc-host-${hostId}-data`,
          },
        },
        runtime: {
          provider: "gcp",
          zone: "us-west1-a",
          instance_id: `cocalc-host-${hostId}`,
          public_ip: "136.109.220.184",
        },
        metrics: {
          current: {
            cpu_percent: 13.4,
            collected_at: "2026-04-06T17:44:33.270Z",
          },
        },
        bootstrap: {
          status: "queued",
          message: "Waiting for cloud host bootstrap",
          updated_at: "2026-04-06T17:48:30.904Z",
        },
        reprovision_required: true,
      },
    });

    const { cloudHostHandlers } = await import("./host-work");
    await expect(
      cloudHostHandlers.start({
        id: "work-1",
        vm_id: hostId,
        action: "start",
        payload: { provider: "gcp" },
      } as any),
    ).rejects.toThrow(/QUOTA_EXCEEDED/);

    const { rows } = await getPool().query(
      "SELECT status, public_url, internal_url, metadata FROM project_hosts WHERE id=$1",
      [hostId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("off");
    expect(rows[0].public_url).toBeNull();
    expect(rows[0].internal_url).toBeNull();
    expect(rows[0].metadata.runtime).toBeUndefined();
    expect(rows[0].metadata.dns).toBeUndefined();
    expect(rows[0].metadata.cloudflare_tunnel).toBeUndefined();
    expect(rows[0].metadata.reprovision_required).toBe(true);
    expect(rows[0].metadata.bootstrap).toMatchObject({
      status: "error",
      message: expect.stringContaining("QUOTA_EXCEEDED"),
    });
    expect(rows[0].metadata.metrics?.current).toBeUndefined();
    expect(rows[0].metadata.last_error).toContain("QUOTA_EXCEEDED");
    expect(removeHostSshKnownHostAliasMock).toHaveBeenCalledWith({
      host_id: hostId,
      reason: "reprovision",
    });
    expect(removeHostSshKnownHostAliasMock).toHaveBeenCalledWith({
      host_id: hostId,
      reason: "provision",
    });
  });

  it("clears host-scoped runtime deployment overrides when a host is deprovisioned", async () => {
    const hostId = "8fca1cf0-a399-4d31-9231-6c681cc202d1";
    await upsertProjectHost({
      id: hostId,
      name: "Delete host",
      region: "us-west1",
      status: "deprovisioning",
      public_url: "https://host.example.test",
      internal_url: "http://10.0.0.2:9002",
      metadata: {
        owner: "acct-owner",
        machine: {
          cloud: "gcp",
          zone: "us-west1-a",
          machine_type: "n2-standard-4",
          disk_gb: 100,
          disk_type: "ssd",
          storage_mode: "persistent",
        },
        runtime: {
          provider: "gcp",
          zone: "us-west1-a",
          instance_id: `cocalc-host-${hostId}`,
          public_ip: "136.109.220.184",
        },
        runtime_deployments: {
          last_known_good_versions: { "project-host": "bundle-v1" },
        },
      },
    });
    await setProjectHostRuntimeDeployments({
      scope_type: "host",
      host_id: hostId,
      requested_by: "test",
      deployments: [
        {
          target_type: "artifact",
          target: "project-bundle",
          desired_version: "bundle-v1",
        },
      ],
      replace: true,
    });

    const { cloudHostHandlers } = await import("./host-work");
    await cloudHostHandlers.delete({
      id: "work-delete-1",
      vm_id: hostId,
      action: "delete",
      payload: { provider: "gcp" },
    } as any);

    const deployments = await listProjectHostRuntimeDeployments({
      scope_type: "host",
      host_id: hostId,
    });
    expect(deployments).toEqual([]);

    const { rows } = await getPool().query(
      "SELECT status, metadata FROM project_hosts WHERE id=$1",
      [hostId],
    );
    expect(rows[0].status).toBe("deprovisioned");
    expect(rows[0].metadata.runtime_deployments).toBeUndefined();
    expect(removeHostSshKnownHostAliasMock).toHaveBeenCalledWith({
      host_id: hostId,
      reason: "delete",
    });
  });

  it("clears Nebius preserved disk ids when a host is fully deprovisioned", async () => {
    const hostId = "bc4e18d4-b12c-4034-a3ee-e1256a2b1875";
    const deleteHost = jest.fn(async () => undefined);
    getProviderContextMock.mockResolvedValue({
      entry: {
        provider: {
          deleteHost,
        },
      },
      creds: {},
    });
    await upsertProjectHost({
      id: hostId,
      name: "Nebius delete host",
      region: "us-central1",
      status: "deprovisioning",
      metadata: {
        owner: "acct-owner",
        machine: {
          cloud: "nebius",
          machine_type: "1gpu-24vcpu-218gb",
          disk_gb: 186,
          disk_type: "ssd_io_m3",
          storage_mode: "persistent",
          metadata: {
            cpu: 24,
            ram_gb: 218,
            data_disk_id: "computedisk-data",
            shared_disk_id: "computedisk-scratch",
            shared_disk_name: "scratch-name",
          },
        },
        runtime: {
          provider: "nebius",
          instance_id: "computeinstance-host",
          metadata: {
            diskIds: {
              boot: "computedisk-boot",
              data: "computedisk-data",
              scratch: "computedisk-scratch",
            },
          },
        },
      },
    });

    const { cloudHostHandlers } = await import("./host-work");
    await cloudHostHandlers.delete({
      id: "work-delete-nebius-1",
      vm_id: hostId,
      action: "delete",
      payload: { provider: "nebius" },
    } as any);

    expect(deleteHost).toHaveBeenCalledWith(
      expect.objectContaining({ instance_id: "computeinstance-host" }),
      {},
    );
    const { rows } = await getPool().query(
      "SELECT status, metadata FROM project_hosts WHERE id=$1",
      [hostId],
    );
    expect(rows[0].status).toBe("deprovisioned");
    expect(rows[0].metadata.machine.metadata.data_disk_id).toBeUndefined();
    expect(rows[0].metadata.machine.metadata.shared_disk_id).toBeUndefined();
    expect(rows[0].metadata.machine.metadata.shared_disk_name).toBeUndefined();
  });

  it("does not mark a spot host running when refresh_runtime sees TERMINATED with stale IP metadata", async () => {
    const hostId = "0ca1f2bc-43e4-48d1-82e8-2f96a76f8f94";
    const getInstance = jest.fn(async () => ({
      instance_id: `cocalc-host-${hostId}`,
      name: `cocalc-host-${hostId}`,
      status: "TERMINATED",
      public_ip: "34.106.236.179",
      private_ip: "10.180.0.16",
      internal_hostname: `cocalc-host-${hostId}.internal`,
    }));
    getProviderContextMock.mockResolvedValue({
      entry: {
        provider: {
          getInstance,
          mapStatus: (status?: string) =>
            status === "TERMINATED" ? "off" : undefined,
        },
      },
      creds: {},
    });

    await upsertProjectHost({
      id: hostId,
      name: "Spot host",
      region: "us-west3",
      status: "starting",
      public_url: "https://host.example.test",
      internal_url: "http://10.180.0.16:9002",
      metadata: {
        owner: "acct-owner",
        pricing_model: "spot",
        desired_state: "running",
        interruption_restore_policy: "immediate",
        last_action: "start",
        last_action_status: "success",
        machine: {
          cloud: "gcp",
          zone: "us-west3-b",
          machine_type: "t2d-standard-16",
          disk_gb: 200,
          disk_type: "balanced",
          storage_mode: "persistent",
        },
        runtime: {
          provider: "gcp",
          zone: "us-west3-b",
          instance_id: `cocalc-host-${hostId}`,
          public_ip: "34.106.236.179",
          private_ip: "10.180.0.16",
        },
      },
    });

    const { cloudHostHandlers } = await import("./host-work");
    await cloudHostHandlers.refresh_runtime({
      id: "work-refresh-1",
      vm_id: hostId,
      action: "refresh_runtime",
      payload: { provider: "gcp", force: true, attempt: 0 },
    } as any);

    const hostRows = await getPool().query(
      "SELECT status, last_seen, metadata FROM project_hosts WHERE id=$1",
      [hostId],
    );
    expect(hostRows.rows[0].status).toBe("off");
    expect(hostRows.rows[0].last_seen).toBeNull();
    expect(hostRows.rows[0].metadata.runtime.provider_status).toBe(
      "TERMINATED",
    );

    const workRows = await getPool().query(
      "SELECT action, state, payload FROM cloud_vm_work WHERE vm_id=$1 ORDER BY created_at",
      [hostId],
    );
    expect(workRows.rows.map((row) => row.action)).toContain("start");
    expect(
      workRows.rows.find((row) => row.action === "start")?.payload,
    ).toMatchObject({
      source: "refresh_runtime",
      reason: "provider-status:TERMINATED",
    });
  });

  it("passes queued refresh_runtime payload through to force observation", async () => {
    const hostId = "d8d2ca6f-563d-473d-a01d-2b4a7e8bdd89";
    const getInstance = jest.fn(async () => ({
      instance_id: `cocalc-host-${hostId}`,
      name: `cocalc-host-${hostId}`,
      status: "TERMINATED",
      public_ip: null,
      private_ip: "10.180.0.23",
      internal_hostname: `cocalc-host-${hostId}.internal`,
    }));
    getProviderContextMock.mockResolvedValue({
      entry: {
        provider: {
          getInstance,
          mapStatus: (status?: string) =>
            status === "TERMINATED" ? "off" : undefined,
        },
      },
      creds: {},
    });

    await upsertProjectHost({
      id: hostId,
      name: "Forced refresh host",
      region: "us-west3",
      status: "running",
      public_url: "https://host.example.test",
      internal_url: "http://cocalc-host.internal:9002",
      metadata: {
        owner: "acct-owner",
        pricing_model: "spot",
        desired_state: "running",
        interruption_restore_policy: "immediate",
        machine: {
          cloud: "gcp",
          zone: "us-west3-b",
          machine_type: "t2d-standard-4",
          disk_gb: 50,
          disk_type: "balanced",
          storage_mode: "persistent",
        },
        runtime: {
          provider: "gcp",
          zone: "us-west3-b",
          instance_id: `cocalc-host-${hostId}`,
          public_ip: "34.106.236.179",
          private_ip: "10.180.0.23",
          internal_hostname: `cocalc-host-${hostId}.internal`,
        },
      },
    });

    const { cloudHostHandlers } = await import("./host-work");
    await cloudHostHandlers.refresh_runtime({
      id: "work-refresh-2",
      vm_id: hostId,
      action: "refresh_runtime",
      payload: { provider: "gcp", force: true, attempt: 7 },
    } as any);

    expect(getInstance).toHaveBeenCalled();
    const hostRows = await getPool().query(
      "SELECT status, last_seen, metadata FROM project_hosts WHERE id=$1",
      [hostId],
    );
    expect(hostRows.rows[0].status).toBe("off");
    expect(hostRows.rows[0].last_seen).toBeNull();
    expect(hostRows.rows[0].metadata.runtime.provider_status).toBe(
      "TERMINATED",
    );
  });

  it("reschedules verify_host_ready while the current check is in progress", async () => {
    const hostId = "d848a2ca-5f63-4473-b01d-2b4a7e8bdd90";
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const deadlineAt = new Date(Date.now() + 5 * 60_000).toISOString();
    await upsertProjectHost({
      id: hostId,
      name: "Verify retry host",
      region: "us-west3",
      status: "starting",
      metadata: {
        owner: "acct-owner",
        pricing_model: "spot",
        desired_pricing_model: "spot",
        effective_pricing_model: "spot",
        interruption_restore_policy: "immediate",
        machine: {
          cloud: "gcp",
          zone: "us-west3-b",
          machine_type: "t2d-standard-4",
          disk_gb: 50,
          disk_type: "balanced",
          storage_mode: "persistent",
        },
        spot_recovery_state: {
          phase: "returning_to_spot",
          outage_started_at: "2026-05-04T03:00:00.000Z",
          verification_started_at: startedAt,
          verification_deadline_at: deadlineAt,
        },
      },
    });
    await getPool().query(
      `
        INSERT INTO cloud_vm_work (id, vm_id, action, payload, state)
        VALUES ($1, $2, 'verify_host_ready', $3, 'in_progress')
      `,
      [
        "1f96f8b2-1a69-4e88-95a8-69c1d8f5e3b7",
        hostId,
        {
          provider: "gcp",
          started_at: startedAt,
          deadline_at: deadlineAt,
        },
      ],
    );

    const { cloudHostHandlers } = await import("./host-work");
    await cloudHostHandlers.verify_host_ready({
      id: "1f96f8b2-1a69-4e88-95a8-69c1d8f5e3b7",
      vm_id: hostId,
      action: "verify_host_ready",
      payload: {
        provider: "gcp",
        started_at: startedAt,
        deadline_at: deadlineAt,
      },
    } as any);

    const workRows = await getPool().query(
      `
        SELECT state, action
        FROM cloud_vm_work
        WHERE vm_id=$1
        ORDER BY created_at, id
      `,
      [hostId],
    );
    expect(workRows.rows.map((row) => row.state).sort()).toEqual([
      "in_progress",
      "queued",
    ]);
    expect(workRows.rows.map((row) => row.action)).toEqual([
      "verify_host_ready",
      "verify_host_ready",
    ]);
  });

  it("queues RootFS pre-pull work when a host becomes operational", async () => {
    const hostId = "a81b9181-39af-4a75-8c43-33f7f481a059";
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    await upsertProjectHost({
      id: hostId,
      name: "Prepull ready host",
      region: "us-west3",
      status: "running",
      last_seen: new Date() as any,
      metadata: {
        owner: "acct-owner",
        machine: {
          cloud: "gcp",
          zone: "us-west3-b",
          machine_type: "t2d-standard-4",
          disk_gb: 50,
          disk_type: "balanced",
          storage_mode: "persistent",
        },
      },
    });

    const { cloudHostHandlers } = await import("./host-work");
    await cloudHostHandlers.verify_host_ready({
      id: "verify-prepull-1",
      vm_id: hostId,
      action: "verify_host_ready",
      payload: {
        provider: "gcp",
        started_at: startedAt,
      },
    } as any);

    const workRows = await getPool().query(
      `
        SELECT action, state, payload
        FROM cloud_vm_work
        WHERE vm_id=$1
      `,
      [hostId],
    );
    expect(workRows.rows).toHaveLength(1);
    expect(workRows.rows[0]).toMatchObject({
      action: "prepull_rootfs",
      state: "queued",
    });
    expect(workRows.rows[0].payload).toMatchObject({
      source: "verify_host_ready",
      provider: "gcp",
    });
  });

  it("pre-pulls configured and catalog RootFS images for the host architecture", async () => {
    const hostId = "9c7f0920-7f87-446a-a6d7-e1ab8a79116d";
    const pullRootfsImage = jest.fn(async () => ({}));
    getRoutedHostControlClientMock.mockResolvedValue({ pullRootfsImage });
    getServerSettingsMock.mockResolvedValue({
      dns: "launchpad.example.test",
      project_rootfs_default_image: "default/rootfs:latest",
      project_rootfs_default_image_gpu: "",
      project_rootfs_prepull_images: "extra/rootfs:one",
    });
    await upsertProjectHost({
      id: hostId,
      name: "Prepull worker host",
      region: "us-west3",
      status: "running",
      last_seen: new Date() as any,
      metadata: {
        owner: "acct-owner",
        machine: {
          cloud: "gcp",
          zone: "us-west3-b",
          machine_type: "t2d-standard-4",
          disk_gb: 50,
          disk_type: "balanced",
          storage_mode: "persistent",
          metadata: {
            arch: "amd64",
          },
        },
      },
    });
    await getPool().query(
      `
        INSERT INTO rootfs_images
          (image_id, runtime_image, label, family, version, visibility, prepull, arch,
           deleted, hidden, blocked, created, updated)
        VALUES
          ('test-prepull-amd64-v1', 'cocalc.local/rootfs/catalog-amd64-v1', 'amd64 image v1',
           'test-family', '1.0', 'public', true, 'amd64', false, false, false, NOW() - interval '1 day', NOW() - interval '1 day'),
          ('test-prepull-amd64-v2', 'cocalc.local/rootfs/catalog-amd64-v2', 'amd64 image v2',
           'test-family', '1.1', 'public', true, 'amd64', false, false, false, NOW(), NOW()),
          ('test-prepull-arm64', 'cocalc.local/rootfs/catalog-arm64', 'arm64 image',
           'test-family', '1.1', 'public', true, 'arm64', false, false, false, NOW(), NOW()),
          ('test-prepull-hidden', 'cocalc.local/rootfs/hidden', 'hidden image',
           'hidden-family', '1.0', 'public', true, 'amd64', false, true, false, NOW(), NOW())
        ON CONFLICT (image_id) DO UPDATE SET
          runtime_image = EXCLUDED.runtime_image,
          family = EXCLUDED.family,
          version = EXCLUDED.version,
          prepull = EXCLUDED.prepull,
          arch = EXCLUDED.arch,
          deleted = EXCLUDED.deleted,
          hidden = EXCLUDED.hidden,
          blocked = EXCLUDED.blocked,
          updated = NOW()
      `,
    );

    const { cloudHostHandlers } = await import("./host-work");
    await cloudHostHandlers.prepull_rootfs({
      id: "prepull-rootfs-1",
      vm_id: hostId,
      action: "prepull_rootfs",
      payload: {},
    } as any);

    expect(pullRootfsImage.mock.calls.map(([arg]) => arg.image)).toEqual([
      "default/rootfs:latest",
      "extra/rootfs:one",
      "cocalc.local/rootfs/catalog-amd64-v2",
    ]);
    expect(getRoutedHostControlClientMock).toHaveBeenCalledWith({
      host_id: hostId,
      timeout: 30 * 60 * 1000,
    });
    expect(
      maybeAutoGrowHostDiskForReservationFailureMock,
    ).not.toHaveBeenCalled();
  });

  it("schedules spot recovery when the cloud VM disappears during readiness verification", async () => {
    const hostId = "40f6e06d-75ec-4030-8709-7af14fe72127";
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const deadlineAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const getInstance = jest.fn(async () => undefined);
    getProviderContextMock.mockResolvedValue({
      entry: {
        provider: {
          getInstance,
          mapStatus: (status?: string) =>
            status === "STOPPED" ? "off" : undefined,
        },
      },
      creds: {},
    });

    await upsertProjectHost({
      id: hostId,
      name: "Preempted verify host",
      region: "us-central1",
      status: "starting",
      public_url: "https://host.example.test",
      internal_url: "https://host.example.test",
      metadata: {
        owner: "acct-owner",
        pricing_model: "spot",
        desired_pricing_model: "spot",
        effective_pricing_model: "spot",
        interruption_restore_policy: "immediate",
        machine: {
          cloud: "nebius",
          machine_type: "1gpu-16vcpu-200gb",
          disk_gb: 93,
          disk_type: "ssd",
          storage_mode: "persistent",
        },
        runtime: {
          provider: "nebius",
          instance_id: "computeinstance-preempted",
          public_ip: "204.12.170.177",
        },
        bootstrap: {
          status: "queued",
          message: "Waiting for cloud host bootstrap",
        },
      },
    });

    const { cloudHostHandlers } = await import("./host-work");
    await cloudHostHandlers.verify_host_ready({
      id: "verify-preempted-1",
      vm_id: hostId,
      action: "verify_host_ready",
      payload: {
        provider: "nebius",
        started_at: startedAt,
        deadline_at: deadlineAt,
      },
    } as any);

    expect(getInstance).toHaveBeenCalled();
    const hostRows = await getPool().query(
      "SELECT status, last_seen, public_url, internal_url, metadata FROM project_hosts WHERE id=$1",
      [hostId],
    );
    expect(hostRows.rows[0].status).toBe("starting");
    expect(hostRows.rows[0].last_seen).toBeNull();
    expect(hostRows.rows[0].public_url).toBeNull();
    expect(hostRows.rows[0].internal_url).toBeNull();
    expect(hostRows.rows[0].metadata.last_error).toContain(
      "Cloud VM disappeared before the host became ready",
    );
    expect(hostRows.rows[0].metadata.bootstrap).toMatchObject({
      status: "error",
      message: expect.stringContaining(
        "Cloud VM disappeared before the host became ready",
      ),
    });
    expect(hostRows.rows[0].metadata.runtime.provider_status).toBe("missing");
    expect(hostRows.rows[0].metadata.runtime.public_ip).toBeNull();
    expect(hostRows.rows[0].metadata.desired_state).toBe("running");
    expect(hostRows.rows[0].metadata.spot_recovery_state).toMatchObject({
      phase: "retrying_spot",
      attempt: 1,
    });

    const workRows = await getPool().query(
      `
        SELECT action, state
        FROM cloud_vm_work
        WHERE vm_id=$1
      `,
      [hostId],
    );
    expect(workRows.rows).toEqual([
      {
        action: "start",
        state: "queued",
      },
    ]);
  });

  it("recreates Nebius spot hosts as standard fallback while preserving data disk", async () => {
    const hostId = "31ce875c-b30d-4863-950d-6a9b85a58b8a";
    const deleteHost = jest.fn(async () => undefined);
    const startHost = jest.fn(async () => undefined);
    const getStatus = jest.fn(async () => "running");
    getProviderContextMock.mockResolvedValue({
      entry: {
        provider: {
          deleteHost,
          startHost,
          getStatus,
          setPricingModel: jest.fn(async () => {
            throw new Error("Nebius should recreate instead");
          }),
        },
      },
      creds: {},
    });
    provisionIfNeededMock.mockImplementation(async (row) => ({
      ...row,
      status: "running",
      metadata: {
        ...row.metadata,
        runtime: {
          provider: "nebius",
          instance_id: "standard-instance",
          ssh_user: "ubuntu",
          metadata: {
            diskIds: {
              data: "data-disk",
              boot: "new-boot-disk",
            },
          },
        },
      },
    }));

    await upsertProjectHost({
      id: hostId,
      name: "Nebius fallback host",
      region: "eu-north1",
      status: "starting",
      metadata: {
        owner: "acct-owner",
        pricing_model: "spot",
        desired_pricing_model: "spot",
        effective_pricing_model: "spot",
        interruption_restore_policy: "immediate",
        machine: {
          cloud: "nebius",
          machine_type: "gpu-h100",
          platform: "gpu-h100",
          disk_gb: 200,
          disk_type: "ssd",
          storage_mode: "persistent",
          metadata: {
            source_image: "image-1",
          },
        },
        runtime: {
          provider: "nebius",
          instance_id: "spot-instance",
          ssh_user: "ubuntu",
          metadata: {
            diskIds: {
              data: "data-disk",
              boot: "old-boot-disk",
            },
          },
        },
        spot_recovery_policy: {
          max_restore_attempts_before_fallback: 1,
        },
        spot_recovery_state: {
          phase: "retrying_spot",
          outage_started_at: "2026-05-04T03:00:00.000Z",
          attempt: 1,
        },
      },
    });

    const { cloudHostHandlers } = await import("./host-work");
    await cloudHostHandlers.start({
      id: "start-nebius-fallback-1",
      vm_id: hostId,
      action: "start",
      payload: { provider: "nebius" },
    } as any);

    expect(deleteHost).toHaveBeenCalledWith(
      expect.objectContaining({ instance_id: "spot-instance" }),
      {},
      { preserveDataDisk: true },
    );
    expect(startHost).not.toHaveBeenCalled();
    const provisionRow = provisionIfNeededMock.mock.calls[0][0];
    expect(provisionRow.metadata).toMatchObject({
      desired_pricing_model: "spot",
      effective_pricing_model: "on_demand",
      machine: {
        metadata: {
          data_disk_id: "data-disk",
        },
      },
    });
    expect(provisionRow.metadata.runtime).toBeUndefined();

    const hostRows = await getPool().query(
      "SELECT status, metadata FROM project_hosts WHERE id=$1",
      [hostId],
    );
    expect(hostRows.rows[0].status).toBe("starting");
    expect(hostRows.rows[0].metadata.effective_pricing_model).toBe("on_demand");
    expect(hostRows.rows[0].metadata.runtime.instance_id).toBe(
      "standard-instance",
    );
    expect(hostRows.rows[0].metadata.spot_recovery_state.phase).toBe(
      "running_standard_fallback",
    );
  });

  it("returns stopped Nebius standard fallback hosts to spot on manual start", async () => {
    const hostId = "6be1c093-31f0-4d1a-8b27-8333cbe0ed68";
    const deleteHost = jest.fn(async () => undefined);
    const startHost = jest.fn(async () => undefined);
    const getStatus = jest.fn(async () => "running");
    getProviderContextMock.mockResolvedValue({
      entry: {
        provider: {
          deleteHost,
          startHost,
          getStatus,
          setPricingModel: jest.fn(async () => {
            throw new Error("Nebius should recreate instead");
          }),
        },
      },
      creds: {},
    });
    provisionIfNeededMock.mockImplementation(async (row) => ({
      ...row,
      status: "running",
      metadata: {
        ...row.metadata,
        runtime: {
          provider: "nebius",
          instance_id: "spot-instance-new",
          ssh_user: "ubuntu",
          metadata: {
            diskIds: {
              data: "data-disk",
              boot: "new-boot-disk",
            },
          },
        },
      },
    }));

    await upsertProjectHost({
      id: hostId,
      name: "Stopped Nebius fallback host",
      region: "eu-north1",
      status: "starting",
      metadata: {
        owner: "acct-owner",
        pricing_model: "spot",
        desired_pricing_model: "spot",
        effective_pricing_model: "on_demand",
        interruption_restore_policy: "immediate",
        machine: {
          cloud: "nebius",
          machine_type: "gpu-h100",
          platform: "gpu-h100",
          disk_gb: 200,
          disk_type: "ssd",
          storage_mode: "persistent",
          metadata: {
            source_image: "image-1",
          },
        },
        runtime: {
          provider: "nebius",
          instance_id: "standard-instance",
          ssh_user: "ubuntu",
          provider_status: "STOPPED",
          metadata: {
            diskIds: {
              data: "data-disk",
              boot: "standard-boot-disk",
            },
          },
        },
        spot_recovery_policy: {
          max_restore_attempts_before_fallback: 1,
        },
        spot_recovery_state: {
          phase: "running_standard_fallback",
          outage_started_at: "2026-05-04T03:00:00.000Z",
          fallback_started_at: "2026-05-04T03:05:00.000Z",
        },
      },
    });

    const { cloudHostHandlers } = await import("./host-work");
    await cloudHostHandlers.start({
      id: "start-nebius-return-to-spot-1",
      vm_id: hostId,
      action: "start",
      payload: { provider: "nebius" },
    } as any);

    expect(deleteHost).toHaveBeenCalledWith(
      expect.objectContaining({ instance_id: "standard-instance" }),
      {},
      { preserveDataDisk: true },
    );
    expect(startHost).not.toHaveBeenCalled();
    const provisionRow = provisionIfNeededMock.mock.calls[0][0];
    expect(provisionRow.metadata).toMatchObject({
      desired_pricing_model: "spot",
      effective_pricing_model: "spot",
      machine: {
        metadata: {
          data_disk_id: "data-disk",
        },
      },
      spot_recovery_state: {
        phase: "returning_to_spot",
      },
    });

    const hostRows = await getPool().query(
      "SELECT status, metadata FROM project_hosts WHERE id=$1",
      [hostId],
    );
    expect(hostRows.rows[0].status).toBe("starting");
    expect(hostRows.rows[0].metadata.effective_pricing_model).toBe("spot");
    expect(hostRows.rows[0].metadata.runtime.instance_id).toBe(
      "spot-instance-new",
    );
    expect(hostRows.rows[0].metadata.spot_recovery_state.phase).toBe(
      "returning_to_spot",
    );
  }, 10000);

  it("recreates a stopped Nebius runtime when it does not match spot configuration", async () => {
    const hostId = "14a424e6-3dd6-4979-ac40-d5fdf1935238";
    const deleteHost = jest.fn(async () => undefined);
    const startHost = jest.fn(async () => undefined);
    const getStatus = jest.fn(async () => "running");
    const getInstance = jest
      .fn()
      .mockResolvedValueOnce({
        instance_id: "standard-instance",
        status: "STOPPED",
        metadata: {
          machine_type: "gpu-h100-standard",
          platform: "gpu-h100",
          pricing_model: "on_demand",
          preemptible: false,
        },
      })
      .mockResolvedValueOnce({
        instance_id: "spot-instance-new",
        status: "RUNNING",
        metadata: {
          machine_type: "gpu-h100-spot",
          platform: "gpu-h100",
          pricing_model: "spot",
          preemptible: true,
        },
      });
    getProviderContextMock.mockResolvedValue({
      entry: {
        provider: {
          deleteHost,
          startHost,
          getStatus,
          getInstance,
        },
      },
      creds: {},
    });
    provisionIfNeededMock.mockImplementation(async (row) => ({
      ...row,
      status: "running",
      metadata: {
        ...row.metadata,
        runtime: {
          provider: "nebius",
          instance_id: "spot-instance-new",
          ssh_user: "ubuntu",
          metadata: {
            diskIds: {
              data: "data-disk",
              boot: "new-boot-disk",
            },
          },
        },
      },
    }));

    await upsertProjectHost({
      id: hostId,
      name: "Stale Nebius runtime host",
      region: "eu-north1",
      status: "off",
      metadata: {
        owner: "acct-owner",
        pricing_model: "spot",
        desired_pricing_model: "spot",
        effective_pricing_model: "spot",
        interruption_restore_policy: "none",
        machine: {
          cloud: "nebius",
          machine_type: "gpu-h100-spot",
          platform: "gpu-h100",
          disk_gb: 200,
          disk_type: "ssd",
          storage_mode: "persistent",
          metadata: {
            platform: "gpu-h100",
            source_image: "image-1",
          },
        },
        runtime: {
          provider: "nebius",
          instance_id: "standard-instance",
          ssh_user: "ubuntu",
          metadata: {
            diskIds: {
              data: "data-disk",
              boot: "standard-boot-disk",
            },
          },
        },
      },
    });

    const { cloudHostHandlers } = await import("./host-work");
    await cloudHostHandlers.start({
      id: "start-nebius-stale-runtime-1",
      vm_id: hostId,
      action: "start",
      payload: { provider: "nebius" },
    } as any);

    expect(getInstance).toHaveBeenCalled();
    expect(deleteHost).toHaveBeenCalledWith(
      expect.objectContaining({ instance_id: "standard-instance" }),
      {},
      { preserveDataDisk: true },
    );
    expect(startHost).not.toHaveBeenCalled();
    const provisionRow = provisionIfNeededMock.mock.calls[0][0];
    expect(provisionRow.metadata).toMatchObject({
      desired_pricing_model: "spot",
      effective_pricing_model: "spot",
      machine: {
        machine_type: "gpu-h100-spot",
        metadata: {
          data_disk_id: "data-disk",
        },
      },
    });

    const hostRows = await getPool().query(
      "SELECT status, metadata FROM project_hosts WHERE id=$1",
      [hostId],
    );
    expect(hostRows.rows[0].status).toBe("starting");
    expect(hostRows.rows[0].metadata.runtime.instance_id).toBe(
      "spot-instance-new",
    );
  });

  it("starts spot-only Nebius hosts as spot even if stale effective pricing is standard", async () => {
    const hostId = "ab8e71c9-ef9c-4c9a-97d9-e62ecf1c72b4";
    const deleteHost = jest.fn(async () => undefined);
    const startHost = jest.fn(async () => undefined);
    const getStatus = jest.fn(async () => "running");
    const getInstance = jest
      .fn()
      .mockResolvedValueOnce({
        instance_id: "standard-instance",
        status: "STOPPED",
        metadata: {
          machine_type: "gpu-h100",
          platform: "gpu-h100",
          pricing_model: "on_demand",
          preemptible: false,
        },
      })
      .mockResolvedValueOnce({
        instance_id: "spot-instance-new",
        status: "RUNNING",
        metadata: {
          machine_type: "gpu-h100",
          platform: "gpu-h100",
          pricing_model: "spot",
          preemptible: true,
        },
      });
    getProviderContextMock.mockResolvedValue({
      entry: {
        provider: {
          deleteHost,
          startHost,
          getStatus,
          getInstance,
        },
      },
      creds: {},
    });
    provisionIfNeededMock.mockImplementation(async (row) => ({
      ...row,
      status: "running",
      metadata: {
        ...row.metadata,
        runtime: {
          provider: "nebius",
          instance_id: "spot-instance-new",
          ssh_user: "ubuntu",
          metadata: {
            diskIds: {
              data: "data-disk",
              boot: "new-boot-disk",
            },
          },
        },
      },
    }));

    await upsertProjectHost({
      id: hostId,
      name: "Spot-only Nebius host",
      region: "eu-north1",
      status: "off",
      metadata: {
        owner: "acct-owner",
        pricing_model: "spot",
        desired_pricing_model: "spot",
        effective_pricing_model: "on_demand",
        interruption_restore_policy: "none",
        machine: {
          cloud: "nebius",
          machine_type: "gpu-h100",
          platform: "gpu-h100",
          disk_gb: 200,
          disk_type: "ssd",
          storage_mode: "persistent",
          metadata: {
            platform: "gpu-h100",
            source_image: "image-1",
          },
        },
        runtime: {
          provider: "nebius",
          instance_id: "standard-instance",
          ssh_user: "ubuntu",
          metadata: {
            diskIds: {
              data: "data-disk",
              boot: "standard-boot-disk",
            },
          },
        },
      },
    });

    const { cloudHostHandlers } = await import("./host-work");
    await cloudHostHandlers.start({
      id: "start-nebius-spot-only-stale-effective-1",
      vm_id: hostId,
      action: "start",
      payload: { provider: "nebius" },
    } as any);

    expect(getInstance).toHaveBeenCalled();
    expect(deleteHost).toHaveBeenCalledWith(
      expect.objectContaining({ instance_id: "standard-instance" }),
      {},
      { preserveDataDisk: true },
    );
    expect(startHost).not.toHaveBeenCalled();
    const provisionRow = provisionIfNeededMock.mock.calls[0][0];
    expect(provisionRow.metadata).toMatchObject({
      desired_pricing_model: "spot",
      effective_pricing_model: "spot",
      machine: {
        metadata: {
          data_disk_id: "data-disk",
        },
      },
    });

    const hostRows = await getPool().query(
      "SELECT status, metadata FROM project_hosts WHERE id=$1",
      [hostId],
    );
    expect(hostRows.rows[0].status).toBe("starting");
    expect(hostRows.rows[0].metadata.effective_pricing_model).toBe("spot");
    expect(hostRows.rows[0].metadata.runtime.instance_id).toBe(
      "spot-instance-new",
    );
  });

  it("rejects Nebius provision results that are not actually spot", async () => {
    const hostId = "1a922e22-0272-4639-ac9a-d7bf5de4a59a";
    const deleteHost = jest.fn(async () => undefined);
    const getStatus = jest.fn(async () => "running");
    const getInstance = jest
      .fn()
      .mockResolvedValueOnce({
        metadata: {
          machine_type: "gpu-h200",
          platform: "gpu-h200-sxm",
          pricing_model: "on_demand",
          preemptible: false,
        },
      })
      .mockResolvedValueOnce(undefined);
    getProviderContextMock.mockResolvedValue({
      entry: {
        provider: {
          deleteHost,
          getStatus,
          getInstance,
        },
      },
      creds: {},
    });
    provisionIfNeededMock.mockImplementation(async (row) => ({
      ...row,
      status: "running",
      metadata: {
        ...row.metadata,
        runtime: {
          provider: "nebius",
          instance_id: "created-standard-instance",
          ssh_user: "ubuntu",
          metadata: {
            diskIds: {
              data: "data-disk",
              boot: "boot-disk",
            },
          },
        },
      },
    }));

    await upsertProjectHost({
      id: hostId,
      name: "Nebius bad spot create",
      region: "eu-north1",
      status: "starting",
      metadata: {
        owner: "acct-owner",
        pricing_model: "spot",
        desired_pricing_model: "spot",
        effective_pricing_model: "spot",
        interruption_restore_policy: "immediate",
        machine: {
          cloud: "nebius",
          machine_type: "gpu-h200",
          metadata: {
            platform: "gpu-h200-sxm",
            data_disk_id: "data-disk",
          },
          disk_gb: 200,
          disk_type: "ssd",
          storage_mode: "persistent",
        },
      },
    });

    const { cloudHostHandlers } = await import("./host-work");
    await expect(
      cloudHostHandlers.start({
        id: "nebius-bad-spot-create",
        vm_id: hostId,
        action: "start",
        payload: { provider: "nebius" },
      } as any),
    ).rejects.toThrow("does not match the requested host configuration");

    expect(deleteHost).toHaveBeenCalledWith(
      expect.objectContaining({ instance_id: "created-standard-instance" }),
      {},
      { preserveDataDisk: true },
    );

    const hostRows = await getPool().query(
      "SELECT status, metadata FROM project_hosts WHERE id=$1",
      [hostId],
    );
    expect(hostRows.rows[0].status).toBe("off");
    expect(hostRows.rows[0].metadata.last_error).toContain(
      "does not match the requested host configuration",
    );
  });

  it("marks failed starts off when the provider reports the VM stopped", async () => {
    const hostId = "2a4389a8-8134-44f2-b8d6-4cddc4efab11";
    const startHost = jest.fn(async () => {
      throw new Error("provider start failed");
    });
    const getInstance = jest.fn(async () => ({
      instance_id: "stopped-instance",
      status: "STOPPED",
    }));
    getProviderContextMock.mockResolvedValue({
      entry: {
        provider: {
          startHost,
          getInstance,
          mapStatus: (status?: string) =>
            status === "STOPPED" ? "off" : undefined,
        },
      },
      creds: {},
    });

    await upsertProjectHost({
      id: hostId,
      name: "Stopped failed start host",
      region: "eu-north1",
      status: "starting",
      metadata: {
        owner: "acct-owner",
        pricing_model: "on_demand",
        desired_pricing_model: "on_demand",
        effective_pricing_model: "on_demand",
        interruption_restore_policy: "none",
        machine: {
          cloud: "nebius",
          machine_type: "gpu-h100",
          platform: "gpu-h100",
          disk_gb: 200,
          disk_type: "ssd",
          storage_mode: "persistent",
        },
        runtime: {
          provider: "nebius",
          instance_id: "stopped-instance",
          ssh_user: "ubuntu",
        },
      },
    });

    const { cloudHostHandlers } = await import("./host-work");
    await expect(
      cloudHostHandlers.start({
        id: "start-stopped-failure-1",
        vm_id: hostId,
        action: "start",
        payload: { provider: "nebius" },
      } as any),
    ).rejects.toThrow("provider start failed");

    expect(getInstance).toHaveBeenCalled();
    const hostRows = await getPool().query(
      "SELECT status, last_seen, metadata FROM project_hosts WHERE id=$1",
      [hostId],
    );
    expect(hostRows.rows[0].status).toBe("off");
    expect(hostRows.rows[0].last_seen).toBeNull();
    expect(hostRows.rows[0].metadata.last_error).toContain(
      "provider start failed",
    );
    expect(hostRows.rows[0].metadata.runtime.provider_status).toBe("STOPPED");
  });

  it("marks the host error and stops rescheduling when verify_host_ready times out", async () => {
    const hostId = "7cc7a0cb-a4ad-4629-bb9d-cafc6ddb9874";
    await upsertProjectHost({
      id: hostId,
      name: "Verify timeout host",
      region: "us-west3",
      status: "starting",
      metadata: {
        owner: "acct-owner",
        machine: {
          cloud: "gcp",
          zone: "us-west3-b",
          machine_type: "t2d-standard-4",
          disk_gb: 50,
          disk_type: "balanced",
          storage_mode: "persistent",
        },
      },
    });

    const { cloudHostHandlers } = await import("./host-work");
    await expect(
      cloudHostHandlers.verify_host_ready({
        id: "verify-timeout-1",
        vm_id: hostId,
        action: "verify_host_ready",
        payload: {
          provider: "gcp",
          started_at: "2026-05-04T03:20:00.000Z",
          deadline_at: "2026-05-04T03:30:00.000Z",
        },
      } as any),
    ).rejects.toThrow("host did not become ready before the startup deadline");

    const hostRows = await getPool().query(
      "SELECT status, last_seen, metadata FROM project_hosts WHERE id=$1",
      [hostId],
    );
    expect(hostRows.rows[0].status).toBe("error");
    expect(hostRows.rows[0].last_seen).toBeNull();
    expect(hostRows.rows[0].metadata.last_error).toContain(
      "host did not become ready before the startup deadline",
    );

    const workRows = await getPool().query(
      `
        SELECT action, state
        FROM cloud_vm_work
        WHERE vm_id=$1
      `,
      [hostId],
    );
    expect(workRows.rows).toEqual([]);
  });

  it("clears stale last_error when spot recovery completes", async () => {
    const hostId = "c7ddc9e3-65bb-4ab2-89f6-70625cdd3819";
    const lastSeen = "2026-05-04T03:21:23.782Z";
    await upsertProjectHost({
      id: hostId,
      name: "Spot recovery success host",
      region: "us-west3",
      status: "running",
      last_seen: lastSeen as any,
      metadata: {
        owner: "acct-owner",
        pricing_model: "spot",
        desired_pricing_model: "spot",
        effective_pricing_model: "spot",
        interruption_restore_policy: "immediate",
        last_error: "old failure",
        last_error_at: "2026-05-04T03:13:00.000Z",
        machine: {
          cloud: "gcp",
          zone: "us-west3-b",
          machine_type: "t2d-standard-4",
          disk_gb: 50,
          disk_type: "balanced",
          storage_mode: "persistent",
        },
        spot_recovery_state: {
          phase: "returning_to_spot",
          outage_started_at: "2026-05-04T03:02:20.004Z",
          last_probe_at: "2026-05-04T03:19:02.285Z",
          last_probe_result: "success",
          verification_started_at: "2026-05-04T03:20:02.872Z",
          verification_deadline_at: "2026-05-04T03:30:02.872Z",
        },
      },
    });

    const { cloudHostHandlers } = await import("./host-work");
    await cloudHostHandlers.verify_host_ready({
      id: "verify-success-1",
      vm_id: hostId,
      action: "verify_host_ready",
      payload: {
        provider: "gcp",
        started_at: "2026-05-04T03:20:02.872Z",
        deadline_at: "2026-05-04T03:30:02.872Z",
      },
    } as any);

    const hostRows = await getPool().query(
      "SELECT metadata FROM project_hosts WHERE id=$1",
      [hostId],
    );
    expect(hostRows.rows[0].metadata.last_error).toBeUndefined();
    expect(hostRows.rows[0].metadata.last_error_at).toBeUndefined();
    expect(hostRows.rows[0].metadata.spot_recovery_state).toEqual({
      phase: "idle",
      outage_started_at: "2026-05-04T03:02:20.004Z",
      last_recovered_at: expect.any(String),
      last_probe_at: "2026-05-04T03:19:02.285Z",
      last_probe_result: "success",
    });

    const logRows = await getPool().query(
      `
        SELECT action, status
        FROM cloud_vm_log
        WHERE vm_id=$1
        ORDER BY ts DESC
      `,
      [hostId],
    );
    expect(logRows.rows[0]).toMatchObject({
      action: "spot_return_succeeded",
      status: "success",
    });
  });

  it("falls back to standard when a recently recovered spot host dies again", async () => {
    const hostId = "c8227e7d-a34a-4e29-9d5e-d246fd31584a";
    const setPricingModel = jest.fn(async () => undefined);
    const startHost = jest.fn(async () => undefined);
    const getStatus = jest.fn(async () => "running");
    getProviderContextMock.mockResolvedValue({
      entry: {
        provider: {
          setPricingModel,
          startHost,
          getStatus,
        },
      },
      creds: {},
    });

    await upsertProjectHost({
      id: hostId,
      name: "Repeated spot interruption host",
      region: "us-west2",
      status: "running",
      last_seen: new Date(Date.now() - 8 * 60_000) as any,
      metadata: {
        owner: "acct-owner",
        pricing_model: "spot",
        desired_pricing_model: "spot",
        effective_pricing_model: "spot",
        interruption_restore_policy: "immediate",
        machine: {
          cloud: "gcp",
          zone: "us-west2-c",
          machine_type: "t2d-standard-16",
          disk_gb: 200,
          disk_type: "balanced",
          storage_mode: "persistent",
        },
        runtime: {
          provider: "gcp",
          zone: "us-west2-c",
          instance_id: `cocalc-host-${hostId}`,
          provider_status: "TERMINATED",
        },
        spot_recovery_policy: {
          spot_restore_retry_window_minutes: 10,
        },
        spot_recovery_state: {
          phase: "idle",
          outage_started_at: "2026-05-04T03:02:20.004Z",
          last_recovered_at: new Date(Date.now() - 5 * 60_000).toISOString(),
          attempt: 1,
        },
      },
    });

    const { cloudHostHandlers } = await import("./host-work");
    await cloudHostHandlers.start({
      id: "start-repeated-spot-interruption-1",
      vm_id: hostId,
      action: "start",
      payload: {
        provider: "gcp",
        source: "cloud_reconcile",
        reason: "provider-status:TERMINATED",
      },
    } as any);

    expect(setPricingModel).toHaveBeenCalledWith(
      expect.objectContaining({ instance_id: `cocalc-host-${hostId}` }),
      "on_demand",
      {},
    );
    expect(startHost).toHaveBeenCalled();

    const hostRows = await getPool().query(
      "SELECT status, metadata FROM project_hosts WHERE id=$1",
      [hostId],
    );
    expect(hostRows.rows[0].status).toBe("starting");
    expect(hostRows.rows[0].metadata.effective_pricing_model).toBe("on_demand");
    expect(hostRows.rows[0].metadata.spot_recovery_state).toMatchObject({
      phase: "running_standard_fallback",
      outage_started_at: "2026-05-04T03:02:20.004Z",
      attempt: 2,
    });
  });
});
