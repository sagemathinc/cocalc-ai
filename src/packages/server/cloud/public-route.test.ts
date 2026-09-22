/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const queryMock = jest.fn();
const getServerSettingsMock = jest.fn();
const siteUrlMock = jest.fn();
const ensureTunnelMock = jest.fn();
const ensureHostDnsMock = jest.fn();
const ensureAddressDnsMock = jest.fn();
const ensureCloudflareProjectHostSslRuleMock = jest.fn();
const deleteHostDnsMock = jest.fn();
const getCloudflareIpv4CidrsMock = jest.fn();
const getCloudflareZoneSslModeMock = jest.fn();
const ensurePublicIngressMock = jest.fn();
const reconcileBootstrapMock = jest.fn();
const probePublicRouteMock = jest.fn();
const enqueueHostDnsReconciliationMock = jest.fn();

process.env.COCALC_HOST_PUBLIC_ROUTE_STABLE_CONFIRMATION_MS = "0";
process.env.COCALC_HOST_PUBLIC_ROUTE_STABLE_SUCCESS_INTERVAL_MS = "0";

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: queryMock }),
}));

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: (...args: any[]) => getServerSettingsMock(...args),
}));

jest.mock("@cocalc/database/settings/site-url", () => ({
  __esModule: true,
  default: (...args: any[]) => siteUrlMock(...args),
}));

jest.mock("./cloudflare-tunnel", () => ({
  ensureCloudflareTunnelForHost: (...args: any[]) => ensureTunnelMock(...args),
}));

jest.mock("./dns", () => ({
  deleteHostDns: (...args: any[]) => deleteHostDnsMock(...args),
  ensureCloudflareProjectHostSslRule: (...args: any[]) =>
    ensureCloudflareProjectHostSslRuleMock(...args),
  ensureHostDns: (...args: any[]) => ensureHostDnsMock(...args),
  ensureProxiedAddressDns: (...args: any[]) => ensureAddressDnsMock(...args),
  getCloudflareIpv4Cidrs: (...args: any[]) =>
    getCloudflareIpv4CidrsMock(...args),
  getCloudflareZoneSslMode: (...args: any[]) =>
    getCloudflareZoneSslModeMock(...args),
}));

jest.mock("./provider-context", () => ({
  getProviderContext: async () => ({
    entry: {
      provider: { ensurePublicIngress: ensurePublicIngressMock },
    },
    creds: { project_id: "staging-project" },
  }),
}));

jest.mock("./host-dns-reconciliation", () => ({
  enqueueHostDnsReconciliation: (...args: any[]) =>
    enqueueHostDnsReconciliationMock(...args),
}));

jest.mock("@cocalc/server/conat/api/hosts-bootstrap-reconcile", () => ({
  reconcileCloudHostBootstrapOverSsh: (...args: any[]) =>
    reconcileBootstrapMock(...args),
}));

jest.mock("@cocalc/server/hosts/public-route-probe", () => ({
  probeProjectHostPublicRoute: (...args: any[]) =>
    probePublicRouteMock(...args),
}));

describe("project-host public route policy", () => {
  it("defaults managed GCP hosts to proxied public-IP routing", async () => {
    const { desiredHostPublicRouteMode } = await import("./public-route");

    expect(
      desiredHostPublicRouteMode({
        metadata: { machine: { cloud: "gcp" } },
      }),
    ).toBe("cloudflare-proxy");
  });

  it("preserves an explicit tunnel route override", async () => {
    const { desiredHostPublicRouteMode } = await import("./public-route");

    expect(
      desiredHostPublicRouteMode({
        metadata: {
          machine: { cloud: "gcp" },
          public_route: { desired_mode: "cloudflare-tunnel" },
        },
      }),
    ).toBe("cloudflare-tunnel");
  });

  it("keeps non-GCP managed hosts on tunnel routing by default", async () => {
    const { desiredHostPublicRouteMode } = await import("./public-route");

    expect(
      desiredHostPublicRouteMode({
        metadata: { machine: { cloud: "nebius" } },
      }),
    ).toBe("cloudflare-tunnel");
  });

  it("reclaims a route migration abandoned by a terminated worker", async () => {
    const { hostPublicRouteMigrationInProgress } =
      await import("./public-route");
    const nowMs = new Date("2026-09-20T20:00:00.000Z").getTime();

    expect(
      hostPublicRouteMigrationInProgress(
        {
          metadata: {
            public_route: {
              status: "preparing",
              started_at: "2026-09-20T19:55:00.000Z",
            },
          },
        },
        nowMs,
      ),
    ).toBe(true);
    expect(
      hostPublicRouteMigrationInProgress(
        {
          metadata: {
            public_route: {
              status: "preparing",
              started_at: "2026-09-20T17:00:00.000Z",
            },
          },
        },
        nowMs,
      ),
    ).toBe(false);
    expect(
      hostPublicRouteMigrationInProgress(
        {
          metadata: { public_route: { status: "preparing" } },
        },
        nowMs,
      ),
    ).toBe(false);
  });
});

describe("project-host public route migration", () => {
  let row: any;

  beforeEach(() => {
    jest.clearAllMocks();
    row = {
      id: "37782b66-190d-41c3-a7e5-f5662e34cd4a",
      name: "host2",
      region: "us-central1",
      status: "running",
      metadata: {
        machine: { cloud: "gcp" },
        runtime: {
          provider: "gcp",
          instance_id: "staging-host2",
          zone: "us-central1-a",
          public_ip: "203.0.113.20",
        },
        cloudflare_tunnel: {
          id: "tunnel-id",
          hostname:
            "host-37782b66-190d-41c3-a7e5-f5662e34cd4a-staging.example.com",
          record_id: "stable-record",
        },
      },
    };
    queryMock.mockImplementation(async (sql: string, params: any[]) => {
      if (/SELECT id, name, region/.test(sql)) {
        return { rows: [structuredClone(row)] };
      }
      if (/UPDATE project_hosts/.test(sql)) {
        row.metadata ??= {};
        row.metadata[params[1]] = JSON.parse(params[2]);
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    getServerSettingsMock.mockResolvedValue({
      dns: "https://staging.example.com",
      project_hosts_cloudflare_tunnel_host_suffix: "-staging",
    });
    siteUrlMock.mockResolvedValue("https://staging.example.com/");
    getCloudflareIpv4CidrsMock.mockResolvedValue(["173.245.48.0/20"]);
    ensureCloudflareProjectHostSslRuleMock.mockResolvedValue({
      ruleset_id: "ruleset-1",
      rule_id: "rule-1",
      ssl: "full",
    });
    getCloudflareZoneSslModeMock.mockResolvedValue({ value: "full" });
    ensureAddressDnsMock.mockResolvedValue({
      name: "direct-check.example.com",
      record_id: "probe-record",
    });
    ensureHostDnsMock.mockResolvedValue({
      name: "host-37782b66-190d-41c3-a7e5-f5662e34cd4a-staging.example.com",
      record_id: "stable-record",
    });
    deleteHostDnsMock.mockResolvedValue(undefined);
    ensureTunnelMock.mockResolvedValue(row.metadata.cloudflare_tunnel);
    ensurePublicIngressMock.mockResolvedValue(undefined);
    reconcileBootstrapMock.mockResolvedValue(undefined);
    probePublicRouteMock.mockResolvedValue({
      health_status: 200,
      preflight_status: 204,
      session_status: 401,
      websocket_status: 101,
      websocket_attempts: 8,
      websocket_successes: 8,
      websocket_failures: 0,
      websocket_samples: [],
    });
  });

  it("prepares, probes, and activates a proxied public-IP route", async () => {
    const { migrateHostPublicRouteInternal } = await import("./public-route");

    await expect(
      migrateHostPublicRouteInternal({
        id: row.id,
        mode: "cloudflare-proxy",
      }),
    ).resolves.toMatchObject({
      host_id: row.id,
      mode: "cloudflare-proxy",
    });

    expect(ensurePublicIngressMock).toHaveBeenCalledWith(
      row.metadata.runtime,
      { ports: [443], source_ranges: ["173.245.48.0/20"] },
      { project_id: "staging-project" },
    );
    expect(reconcileBootstrapMock).toHaveBeenCalledWith(
      expect.objectContaining({ host_id: row.id, scope: "full" }),
    );
    expect(ensureAddressDnsMock).toHaveBeenCalledWith(
      expect.objectContaining({ ipAddress: "203.0.113.20" }),
    );
    expect(deleteHostDnsMock).toHaveBeenCalledWith(
      expect.objectContaining({ record_id: "probe-record" }),
    );
    expect(ensureHostDnsMock).toHaveBeenCalledWith({
      host_id: row.id,
      ipAddress: "203.0.113.20",
      record_id: "stable-record",
    });
    expect(probePublicRouteMock).toHaveBeenCalledTimes(4);
    expect(probePublicRouteMock).toHaveBeenLastCalledWith({
      public_url:
        "https://host-37782b66-190d-41c3-a7e5-f5662e34cd4a-staging.example.com",
      origin: "https://staging.example.com",
      expected_host_id: row.id,
      timeout_ms: 10_000,
    });
    expect(row.metadata.public_route).toMatchObject({
      desired_mode: "cloudflare-proxy",
      active_mode: "cloudflare-proxy",
      status: "active",
      error: null,
    });
  });

  it("reconciles and persists direct ingress after a runtime address change", async () => {
    const { reconcileDirectCloudflareRouteForHost } =
      await import("./public-route");
    ensurePublicIngressMock.mockResolvedValue({
      instance: { public_ip: "203.0.113.20" },
    });

    await expect(
      reconcileDirectCloudflareRouteForHost(row),
    ).resolves.toMatchObject({
      public_ip: "203.0.113.20",
      dns: { record_id: "stable-record" },
    });

    expect(ensurePublicIngressMock).toHaveBeenCalledTimes(1);
    expect(enqueueHostDnsReconciliationMock).toHaveBeenCalledWith(
      row.id,
      "public-route-auto-repair",
    );
    expect(ensureHostDnsMock).toHaveBeenCalledWith({
      host_id: row.id,
      ipAddress: "203.0.113.20",
      record_id: "stable-record",
    });
    expect(row.metadata.dns).toEqual({
      name: "host-37782b66-190d-41c3-a7e5-f5662e34cd4a-staging.example.com",
      record_id: "stable-record",
    });
  });

  it("repairs stale DNS before a transient ingress reconciliation failure", async () => {
    const { reconcileDirectCloudflareRouteForHost } =
      await import("./public-route");
    getCloudflareIpv4CidrsMock.mockRejectedValueOnce(
      new TypeError("fetch failed"),
    );

    await expect(reconcileDirectCloudflareRouteForHost(row)).rejects.toThrow(
      "fetch failed",
    );

    expect(ensureHostDnsMock).toHaveBeenCalledWith({
      host_id: row.id,
      ipAddress: "203.0.113.20",
      record_id: "stable-record",
    });
    expect(row.metadata.dns).toEqual({
      name: "host-37782b66-190d-41c3-a7e5-f5662e34cd4a-staging.example.com",
      record_id: "stable-record",
    });
    expect(ensurePublicIngressMock).not.toHaveBeenCalled();
  });

  it("restores the tunnel route when direct-route preparation fails", async () => {
    ensurePublicIngressMock.mockRejectedValueOnce(
      new Error("firewall reconciliation failed"),
    );
    const { migrateHostPublicRouteInternal } = await import("./public-route");

    await expect(
      migrateHostPublicRouteInternal({
        id: row.id,
        mode: "cloudflare-proxy",
      }),
    ).rejects.toThrow("firewall reconciliation failed");

    expect(ensureTunnelMock).toHaveBeenCalledWith({
      host_id: row.id,
      existing: row.metadata.cloudflare_tunnel,
    });
    expect(probePublicRouteMock).toHaveBeenCalledTimes(1);
    expect(row.metadata.public_route).toMatchObject({
      desired_mode: "cloudflare-proxy",
      active_mode: "cloudflare-tunnel",
      status: "failed",
    });
  });
});
