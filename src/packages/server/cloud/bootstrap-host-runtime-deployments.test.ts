/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";

let getServerSettingsMock: jest.Mock;
let loadEffectiveProjectHostRuntimeDeploymentsMock: jest.Mock;
let buildHostSpecMock: jest.Mock;
let getLaunchpadLocalConfigMock: jest.Mock;
let ensureCloudflareTunnelForHostMock: jest.Mock;
let getServerProviderMock: jest.Mock;

jest.mock("@cocalc/database/settings/server-settings", () => ({
  __esModule: true,
  getServerSettings: (...args: any[]) => getServerSettingsMock(...args),
}));

jest.mock("@cocalc/database/postgres/project-host-runtime-deployments", () => ({
  __esModule: true,
  loadEffectiveProjectHostRuntimeDeployments: (...args: any[]) =>
    loadEffectiveProjectHostRuntimeDeploymentsMock(...args),
}));

jest.mock("./host-util", () => ({
  __esModule: true,
  buildHostSpec: (...args: any[]) => buildHostSpecMock(...args),
}));

jest.mock("@cocalc/server/launchpad/mode", () => ({
  __esModule: true,
  getLaunchpadLocalConfig: (...args: any[]) =>
    getLaunchpadLocalConfigMock(...args),
}));

jest.mock("./cloudflare-tunnel", () => ({
  __esModule: true,
  ensureCloudflareTunnelForHost: (...args: any[]) =>
    ensureCloudflareTunnelForHostMock(...args),
}));

jest.mock("./providers", () => ({
  __esModule: true,
  getServerProvider: (...args: any[]) => getServerProviderMock(...args),
}));

describe("bootstrap-host promoted artifact defaults", () => {
  let server: http.Server;
  let softwareBaseUrl: string;

  beforeAll(async () => {
    const testHost = Object.values(networkInterfaces())
      .flatMap((addresses) => addresses ?? [])
      .find(
        (address) => address.family === "IPv4" && !address.internal,
      )?.address;
    if (!testHost) {
      throw new Error("managed-host bootstrap test requires a non-loopback IP");
    }
    server = http.createServer((req, res) => {
      const path = req.url ?? "/";
      const sendJson = (payload: any) => {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(payload));
      };
      const sendText = (payload: string) => {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(payload);
      };
      if (path === "/software/project-host/latest-linux.json") {
        sendJson({
          url: `${softwareBaseUrl}/project-host/ph-latest/bundle-linux.tar.xz`,
          sha256: "a".repeat(64),
          os: "linux",
        });
        return;
      }
      if (path === "/software/project/latest-linux.json") {
        sendJson({
          url: `${softwareBaseUrl}/project/pb-latest/bundle-linux.tar.xz`,
          sha256: "b".repeat(64),
          os: "linux",
        });
        return;
      }
      if (path === "/software/tools/latest-linux-amd64.json") {
        sendJson({
          url: `${softwareBaseUrl}/tools/tools-latest/tools-linux-amd64.tar.xz`,
          sha256: "c".repeat(64),
          os: "linux",
          arch: "amd64",
        });
        return;
      }
      if (path === "/software/container-runtime/latest-linux-amd64.json") {
        sendJson({
          url: `${softwareBaseUrl}/container-runtime/runtime-latest/container-runtime-linux-amd64.tar.xz`,
          sha256: "e".repeat(64),
          os: "linux",
          arch: "amd64",
        });
        return;
      }
      if (path.endsWith(".sha256")) {
        if (path.includes("/missing-build/")) {
          res.statusCode = 404;
          res.end("not found");
          return;
        }
        sendText(`${"d".repeat(64)}  ${path.split("/").at(-1) ?? "bundle"}`);
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
    const address = server.address() as AddressInfo;
    softwareBaseUrl = `http://${testHost}:${address.port}/software`;
    process.env.MASTER_CONAT_SERVER = "http://master.example.test";
    process.env.COCALC_GCP_INTERNAL_MASTER_CONAT_MODE = "disabled";
    await import("./bootstrap-host");
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    delete process.env.MASTER_CONAT_SERVER;
    delete process.env.COCALC_GCP_INTERNAL_MASTER_CONAT_MODE;
  });

  beforeEach(() => {
    process.env.MASTER_CONAT_SERVER = "http://master.example.test";
    process.env.COCALC_GCP_INTERNAL_MASTER_CONAT_MODE = "disabled";
    process.env.COCALC_PROJECT_HOST_MANAGED_HARNESSES = "1";
    getServerSettingsMock = jest.fn(async () => ({
      project_hosts_software_base_url: softwareBaseUrl,
      project_hosts_bootstrap_channel: "latest",
      project_hosts_bootstrap_version: "",
    }));
    loadEffectiveProjectHostRuntimeDeploymentsMock = jest.fn(async () => []);
    buildHostSpecMock = jest.fn(async () => ({ disk_gb: 100 }));
    getLaunchpadLocalConfigMock = jest.fn(() => ({ http_port: 9100 }));
    ensureCloudflareTunnelForHostMock = jest.fn(async () => undefined);
    getServerProviderMock = jest.fn(() => undefined);
  });

  afterEach(() => {
    delete process.env.MASTER_CONAT_SERVER;
    delete process.env.COCALC_GCP_INTERNAL_MASTER_CONAT_MODE;
    delete process.env.COCALC_PROJECT_HOST_MANAGED_HARNESSES;
    delete process.env.COCALC_PROJECT_HOST_SOFTWARE_ENDPOINT_MODE;
    delete process.env.COCALC_BAY_ID;
  });

  async function loadBootstrapHost() {
    return await import("./bootstrap-host");
  }

  function baseRow() {
    return {
      id: "host-123",
      name: "spot-utah",
      region: "connector-123",
      metadata: {
        machine: {
          cloud: "self-host",
          metadata: {
            arch: "amd64",
            self_host_mode: "local",
            self_host_kind: "direct",
          },
        },
        runtime: {
          public_ip: "127.0.0.1",
        },
      },
    };
  }

  it("enforces storage admission for site-funded hosts", async () => {
    const { resolveBootstrapStorageAdmissionMode } = await loadBootstrapHost();

    expect(
      resolveBootstrapStorageAdmissionMode({
        billing: { funding_mode: "site-funded" },
      }),
    ).toBe("enforce");
  });

  it("observes storage admission for account-funded hosts by default", async () => {
    const { resolveBootstrapStorageAdmissionMode } = await loadBootstrapHost();

    expect(
      resolveBootstrapStorageAdmissionMode({
        billing: { funding_mode: "account-prepaid" },
      }),
    ).toBe("observe");
  });

  it("honors explicit storage admission overrides", async () => {
    const { resolveBootstrapStorageAdmissionMode } = await loadBootstrapHost();

    expect(
      resolveBootstrapStorageAdmissionMode({
        billing: { funding_mode: "site-funded" },
        storage_admission_mode: "observe",
      }),
    ).toBe("observe");
    expect(
      resolveBootstrapStorageAdmissionMode({
        billing: { funding_mode: "account-postpaid" },
        machine: {
          metadata: { storage_admission_mode: "enforce" },
        },
      }),
    ).toBe("enforce");
  });

  it("uses promoted global artifact versions for bootstrap of new hosts", async () => {
    loadEffectiveProjectHostRuntimeDeploymentsMock.mockResolvedValue([
      {
        scope_type: "global",
        scope_id: "global",
        target_type: "artifact",
        target: "project-host",
        desired_version: "ph-v2",
      },
      {
        scope_type: "global",
        scope_id: "global",
        target_type: "artifact",
        target: "project-bundle",
        desired_version: "pb-v3",
      },
      {
        scope_type: "global",
        scope_id: "global",
        target_type: "artifact",
        target: "tools",
        desired_version: "tools-v4",
      },
      {
        scope_type: "global",
        scope_id: "global",
        target_type: "artifact",
        target: "container-runtime",
        desired_version: "runtime-v6",
      },
      {
        scope_type: "global",
        scope_id: "global",
        target_type: "artifact",
        target: "bootstrap-environment",
        desired_version: "bootstrap-v5",
      },
    ]);

    const { buildBootstrapScripts } = await loadBootstrapHost();
    const scripts = await buildBootstrapScripts(baseRow() as any);

    expect(scripts.projectHostBundleUrl).toBe(
      `${softwareBaseUrl}/project-host/ph-v2/bundle-linux.tar.xz`,
    );
    expect(scripts.projectHostVersion).toBe("ph-v2");
    expect(scripts.projectBundleUrl).toBe(
      `${softwareBaseUrl}/project/pb-v3/bundle-linux.tar.xz`,
    );
    expect(scripts.projectBundleVersion).toBe("pb-v3");
    expect(scripts.toolsUrl).toBe(
      `${softwareBaseUrl}/tools/tools-v4/tools-linux-amd64.tar.xz`,
    );
    expect(scripts.toolsVersion).toBe("tools-v4");
    expect(scripts.toolsManifestUrl).toBe("");
    expect(scripts.containerRuntimeUrl).toBe(
      `${softwareBaseUrl}/container-runtime/runtime-v6/container-runtime-linux-amd64.tar.xz`,
    );
    expect(scripts.containerRuntimeVersion).toBe("runtime-v6");
    expect(scripts.bootstrapSelector).toBe("bootstrap-v5");
    expect(scripts.bootstrapPyUrl).toBe(
      `${softwareBaseUrl}/bootstrap/bootstrap-v5/bootstrap.py`,
    );
    expect(scripts.managedHarness).toEqual({
      name: "claude-code",
      version: "0.81.1",
      install_revision: "0.81.1-r1",
      os: "linux",
      arch: "amd64",
      sha256:
        "aa275272bf79e32ad333790679535d4d45ea2cd32d08a271865e64ed0b6361d1",
      url: `${softwareBaseUrl}/harnesses/claude-code/0.81.1/aa275272bf79e32ad333790679535d4d45ea2cd32d08a271865e64ed0b6361d1/harnesses-linux-amd64.tar.xz`,
    });
    // Older bootstrap runners ignore the new spec; do not enable ACP in them.
    expect(scripts.envLines).not.toContain("COCALC_ACP_HARNESSES=1");
  });

  it("pins a separate immutable payload for each supported architecture", async () => {
    const { resolveManagedHarness } = await loadBootstrapHost();
    const amd64 = resolveManagedHarness(softwareBaseUrl, "linux", "amd64")!;
    const arm64 = resolveManagedHarness(
      `${softwareBaseUrl}/`,
      "linux",
      "arm64",
    )!;
    expect(arm64).toMatchObject({
      name: "claude-code",
      version: "0.81.1",
      install_revision: "0.81.1-r1",
      os: "linux",
      arch: "arm64",
      sha256:
        "e5a52385ff5e95a9c9eeeac8f9875e773a66622af64ccb3fb00a8f5b1708ff88",
    });
    expect(arm64.url).toBe(
      `${softwareBaseUrl}/harnesses/claude-code/0.81.1/${arm64.sha256}/harnesses-linux-arm64.tar.xz`,
    );
    expect(amd64.sha256).not.toBe(arm64.sha256);
    expect(
      resolveManagedHarness(softwareBaseUrl, "darwin", "arm64"),
    ).toBeUndefined();
    expect(
      resolveManagedHarness(softwareBaseUrl, "linux", "s390x"),
    ).toBeUndefined();
  });

  it("does not require optional pinned archives for local development unless opted in", async () => {
    const { buildBootstrapScripts } = await loadBootstrapHost();
    delete process.env.COCALC_PROJECT_HOST_MANAGED_HARNESSES;
    const local = await buildBootstrapScripts(baseRow() as any);
    expect(local.managedHarness).toBeUndefined();
    expect(local.envLines).not.toContain("COCALC_ACP_HARNESSES=1");
    process.env.COCALC_PROJECT_HOST_MANAGED_HARNESSES = "1";
    const optedIn = await buildBootstrapScripts(baseRow() as any);
    expect(optedIn.managedHarness?.name).toBe("claude-code");
    expect(optedIn.envLines).not.toContain("COCALC_ACP_HARNESSES=1");
  });

  it("automatically provisions managed bays but honors local endpoints and a site disable", async () => {
    const { buildBootstrapScripts } = await loadBootstrapHost();
    delete process.env.COCALC_PROJECT_HOST_MANAGED_HARNESSES;
    process.env.COCALC_BAY_ID = "bay-test";
    const row = baseRow();
    row.metadata.machine.metadata.self_host_mode = "cloud";
    row.metadata.runtime.public_ip = "203.0.113.10";
    const managed = await buildBootstrapScripts(row as any);
    expect(managed.managedHarness?.name).toBe("claude-code");
    expect(managed.envLines).not.toContain("COCALC_ACP_HARNESSES=1");
    process.env.COCALC_PROJECT_HOST_SOFTWARE_ENDPOINT_MODE = "local";
    const local = await buildBootstrapScripts(row as any);
    expect(local.managedHarness).toBeUndefined();
    expect(local.envLines).not.toContain("COCALC_ACP_HARNESSES=1");
    delete process.env.COCALC_PROJECT_HOST_SOFTWARE_ENDPOINT_MODE;
    process.env.COCALC_PROJECT_HOST_MANAGED_HARNESSES = "0";
    const disabled = await buildBootstrapScripts(row as any);
    expect(disabled.managedHarness).toBeUndefined();
    expect(disabled.envLines).not.toContain("COCALC_ACP_HARNESSES=1");
  });

  it("includes the pinned harness without eager enablement for older bootstrap runners", async () => {
    const { buildBootstrapScriptWithStatus, resolveManagedHarness } =
      await loadBootstrapHost();
    const script = await buildBootstrapScriptWithStatus(
      baseRow() as any,
      "test-token",
      "https://example.test",
    );
    const match = script.match(
      /bootstrap-desired-state\.json"\n([\s\S]*?)\nEOF_COCALC_BOOTSTRAP_DESIRED_STATE/,
    );
    expect(match).not.toBeNull();
    const desired = JSON.parse(match![1]);
    expect(desired.managed_harness).toEqual(
      resolveManagedHarness(softwareBaseUrl, "linux", "amd64"),
    );
    expect(desired.env_lines).not.toContain("COCALC_ACP_HARNESSES=1");
  });

  it("falls back to the existing latest-manifest behavior when no promoted default exists", async () => {
    const { buildBootstrapScripts } = await loadBootstrapHost();
    const scripts = await buildBootstrapScripts(baseRow() as any);

    expect(scripts.projectHostVersion).toBe("ph-latest");
    expect(scripts.projectBundleVersion).toBe("pb-latest");
    expect(scripts.toolsVersion).toBe("tools-latest");
    expect(scripts.toolsManifestUrl).toBe(
      `${softwareBaseUrl}/tools/latest-linux-amd64.json`,
    );
    expect(scripts.containerRuntimeUrl).toBe(
      `${softwareBaseUrl}/container-runtime/runtime-latest/container-runtime-linux-amd64.tar.xz`,
    );
    expect(scripts.containerRuntimeVersion).toBe("runtime-latest");
    expect(scripts.bootstrapSelector).toBe("latest");
  });

  it("enables additive direct HTTPS ingress for managed GCP hosts", async () => {
    getServerSettingsMock.mockResolvedValue({
      project_hosts_software_base_url: softwareBaseUrl,
      project_hosts_bootstrap_channel: "latest",
      project_hosts_bootstrap_version: "",
      dns: "https://staging.example.com",
      project_hosts_cloudflare_tunnel_host_suffix: "staging",
    });
    ensureCloudflareTunnelForHostMock.mockResolvedValue({
      id: "tunnel-id",
      hostname: "host-host-123-staging.example.com",
      ssh_hostname: "ssh-host-123-staging.example.com",
    });
    const { buildBootstrapScripts } = await loadBootstrapHost();
    const scripts = await buildBootstrapScripts({
      id: "host-123",
      name: "gcp-host",
      region: "us-central1",
      metadata: {
        machine: { cloud: "gcp", zone: "us-central1-a" },
        runtime: {
          provider: "gcp",
          instance_id: "gcp-host",
          public_ip: "203.0.113.20",
          private_ip: "10.0.0.20",
          ssh_user: "ubuntu",
          zone: "us-central1-a",
        },
      },
    } as any);

    expect(scripts.envLines).toContain(
      "COCALC_PROJECT_HOST_DIRECT_HTTPS_PORT=443",
    );
    expect(scripts.envLines).toContain(
      "COCALC_PROJECT_HOST_DIRECT_HTTPS_HOSTNAME=host-host-123-staging.example.com",
    );
    expect(scripts.envLines).toContain("PORT=9002");
    expect(scripts.envLines).toContain("COCALC_PROJECT_HOST_HTTPS=0");
    expect(scripts.cloudflaredConfig.enabled).toBe(true);
    expect(scripts.cloudflaredConfig.examHostname).toBe(
      "exam-host-123-staging.example.com",
    );
  });

  it("advertises the public URL to hubs for cross-VPC GCP hosts", async () => {
    getServerSettingsMock.mockResolvedValue({
      project_hosts_software_base_url: softwareBaseUrl,
      project_hosts_bootstrap_channel: "latest",
      project_hosts_bootstrap_version: "",
      project_hosts_route_mode: "public",
      dns: "https://lite4b.example.com",
      project_hosts_cloudflare_tunnel_host_suffix: "lite4b",
    });
    ensureCloudflareTunnelForHostMock.mockResolvedValue({
      id: "tunnel-id",
      hostname: "host-host-123-lite4b.example.com",
      ssh_hostname: "ssh-host-123-lite4b.example.com",
    });
    const { buildBootstrapScripts } = await loadBootstrapHost();
    const scripts = await buildBootstrapScripts({
      id: "host-123",
      name: "gcp-host",
      region: "us-central1",
      metadata: {
        machine: { cloud: "gcp", zone: "us-central1-a" },
        runtime: {
          provider: "gcp",
          instance_id: "gcp-host",
          public_ip: "203.0.113.20",
          private_ip: "10.0.0.20",
          ssh_user: "ubuntu",
          zone: "us-central1-a",
          metadata: { gcp_project_id: "project-hosts-dev" },
        },
      },
    } as any);

    expect(scripts.publicUrl).toBe("https://host-host-123-lite4b.example.com");
    expect(scripts.internalUrl).toBe(scripts.publicUrl);
    expect(scripts.envLines).toContain(
      "PROJECT_HOST_INTERNAL_URL=https://host-host-123-lite4b.example.com",
    );
  });

  it("does not let bootstrap replace an active direct route with a tunnel cname", async () => {
    getServerSettingsMock.mockResolvedValue({
      project_hosts_software_base_url: softwareBaseUrl,
      project_hosts_bootstrap_channel: "latest",
      project_hosts_bootstrap_version: "",
      dns: "https://staging.example.com",
      project_hosts_cloudflare_tunnel_host_suffix: "staging",
    });
    ensureCloudflareTunnelForHostMock.mockResolvedValue({
      id: "tunnel-id",
      hostname: "host-host-123-staging.example.com",
      ssh_hostname: "ssh-host-123-staging.example.com",
    });
    const { buildBootstrapScripts } = await loadBootstrapHost();
    const scripts = await buildBootstrapScripts({
      id: "host-123",
      name: "gcp-host",
      region: "us-central1",
      ssh_server: "203.0.113.10:2222",
      metadata: {
        public_route: {
          desired_mode: "cloudflare-proxy",
          active_mode: "cloudflare-proxy",
          status: "active",
        },
        machine: { cloud: "gcp", zone: "us-central1-a" },
        runtime: {
          provider: "gcp",
          instance_id: "gcp-host",
          public_ip: "203.0.113.20",
          private_ip: "10.0.0.20",
          ssh_user: "ubuntu",
          zone: "us-central1-a",
        },
      },
    } as any);

    expect(ensureCloudflareTunnelForHostMock).toHaveBeenCalledWith({
      host_id: "host-123",
      existing: undefined,
      publish_browser_dns: false,
    });
    expect(scripts.sshServer).toBe("203.0.113.20:2222");
    expect(scripts.cloudflaredConfig.enabled).toBe(true);
  });

  it("does not republish tunnel browser dns while preparing direct cutover", async () => {
    getServerSettingsMock.mockResolvedValue({
      project_hosts_software_base_url: softwareBaseUrl,
      project_hosts_bootstrap_channel: "latest",
      project_hosts_bootstrap_version: "",
      dns: "https://staging.example.com",
      project_hosts_cloudflare_tunnel_host_suffix: "staging",
    });
    ensureCloudflareTunnelForHostMock.mockResolvedValue({
      id: "tunnel-id",
      hostname: "host-host-123-staging.example.com",
    });
    const { buildBootstrapScripts } = await loadBootstrapHost();
    await buildBootstrapScripts({
      id: "host-123",
      name: "gcp-host",
      region: "us-central1",
      metadata: {
        public_route: {
          desired_mode: "cloudflare-proxy",
          active_mode: "cloudflare-tunnel",
          status: "preparing",
        },
        machine: { cloud: "gcp", zone: "us-central1-a" },
        runtime: {
          provider: "gcp",
          instance_id: "gcp-host",
          public_ip: "203.0.113.20",
          private_ip: "10.0.0.20",
          zone: "us-central1-a",
        },
      },
    } as any);

    expect(ensureCloudflareTunnelForHostMock).toHaveBeenCalledWith({
      host_id: "host-123",
      existing: undefined,
      publish_browser_dns: false,
    });
  });

  it("keeps tunnel browser dns while direct-route preparation has not begun", async () => {
    getServerSettingsMock.mockResolvedValue({
      project_hosts_software_base_url: softwareBaseUrl,
      project_hosts_bootstrap_channel: "latest",
      project_hosts_bootstrap_version: "",
      dns: "https://staging.example.com",
      project_hosts_cloudflare_tunnel_host_suffix: "staging",
    });
    ensureCloudflareTunnelForHostMock.mockResolvedValue({
      id: "tunnel-id",
      hostname: "host-host-123-staging.example.com",
    });
    const { buildBootstrapScripts } = await loadBootstrapHost();
    await buildBootstrapScripts({
      id: "host-123",
      name: "gcp-host",
      region: "us-central1",
      metadata: {
        machine: { cloud: "gcp", zone: "us-central1-a" },
        runtime: {
          provider: "gcp",
          instance_id: "gcp-host",
          public_ip: "203.0.113.20",
          private_ip: "10.0.0.20",
          zone: "us-central1-a",
        },
      },
    } as any);

    expect(ensureCloudflareTunnelForHostMock).toHaveBeenCalledWith({
      host_id: "host-123",
      existing: undefined,
      publish_browser_dns: true,
    });
  });

  it("prefers a newer observed installed artifact version over stale desired runtime deployments", async () => {
    loadEffectiveProjectHostRuntimeDeploymentsMock.mockResolvedValue([
      {
        scope_type: "global",
        scope_id: "global",
        target_type: "artifact",
        target: "project-host",
        desired_version: "1777528468004",
      },
      {
        scope_type: "global",
        scope_id: "global",
        target_type: "artifact",
        target: "project-bundle",
        desired_version: "1777528468004",
      },
      {
        scope_type: "global",
        scope_id: "global",
        target_type: "artifact",
        target: "tools",
        desired_version: "1777528468004",
      },
    ]);

    const { buildBootstrapScripts } = await loadBootstrapHost();
    const scripts = await buildBootstrapScripts({
      ...baseRow(),
      metadata: {
        ...baseRow().metadata,
        software_inventory: [
          {
            artifact: "project-host",
            current_version: "1777603320059",
          },
          {
            artifact: "project-bundle",
            current_version: "1777603320060",
          },
          {
            artifact: "tools",
            current_version: "1777603320061",
          },
        ],
      },
    } as any);

    expect(scripts.projectHostBundleUrl).toBe(
      `${softwareBaseUrl}/project-host/1777603320059/bundle-linux.tar.xz`,
    );
    expect(scripts.projectHostVersion).toBe("1777603320059");
    expect(scripts.projectBundleUrl).toBe(
      `${softwareBaseUrl}/project/1777603320060/bundle-linux.tar.xz`,
    );
    expect(scripts.projectBundleVersion).toBe("1777603320060");
    expect(scripts.toolsUrl).toBe(
      `${softwareBaseUrl}/tools/1777603320061/tools-linux-amd64.tar.xz`,
    );
    expect(scripts.toolsVersion).toBe("1777603320061");
    expect(scripts.toolsManifestUrl).toBe("");
  });

  it("prefers the observed numeric artifact version when the desired project-host deployment is a build id", async () => {
    loadEffectiveProjectHostRuntimeDeploymentsMock.mockResolvedValue([
      {
        scope_type: "host",
        scope_id: "host-123",
        target_type: "artifact",
        target: "project-host",
        desired_version: "20260501T024149Z-d8da8fa36b1e-dirty-789d9dbc",
      },
    ]);

    const { buildBootstrapScripts } = await loadBootstrapHost();
    const scripts = await buildBootstrapScripts({
      ...baseRow(),
      metadata: {
        ...baseRow().metadata,
        software_inventory: [
          {
            artifact: "project-host",
            current_version: "1777603320059",
            current_build_id: "20260501T024149Z-d8da8fa36b1e-dirty-789d9dbc",
          },
        ],
      },
    } as any);

    expect(scripts.projectHostBundleUrl).toBe(
      `${softwareBaseUrl}/project-host/1777603320059/bundle-linux.tar.xz`,
    );
    expect(scripts.projectHostVersion).toBe("1777603320059");
  });

  it("falls back to the latest manifest when a promoted artifact version is no longer served", async () => {
    loadEffectiveProjectHostRuntimeDeploymentsMock.mockResolvedValue([
      {
        scope_type: "global",
        scope_id: "global",
        target_type: "artifact",
        target: "project-host",
        desired_version: "missing-build",
      },
    ]);

    const { buildBootstrapScripts } = await loadBootstrapHost();
    const scripts = await buildBootstrapScripts(baseRow() as any);

    expect(scripts.projectHostBundleUrl).toBe(
      `${softwareBaseUrl}/project-host/ph-latest/bundle-linux.tar.xz`,
    );
    expect(scripts.projectHostVersion).toBe("ph-latest");
  });
});
