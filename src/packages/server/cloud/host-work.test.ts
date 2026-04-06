import { upsertProjectHost } from "@cocalc/database/postgres/project-hosts";
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
});
