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

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);

afterAll(after);

beforeEach(async () => {
  jest.clearAllMocks();
  await getPool().query("DELETE FROM cloud_vm_log");
  await getPool().query("DELETE FROM cloud_vm_work");
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
});
