/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";

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

jest.mock("./ssh-key", () => ({
  __esModule: true,
  getHostSshPublicKeys: async () => [],
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
    // Claude Code ships in the tools bundle; nothing separate to provision.
    expect(scripts).not.toHaveProperty("managedHarness");
  });

  it("writes the project content domain to the host env file when configured", async () => {
    getServerSettingsMock.mockResolvedValue({
      project_hosts_software_base_url: softwareBaseUrl,
      project_hosts_bootstrap_channel: "latest",
      project_hosts_bootstrap_version: "",
      project_content_dns: " https://UserContent.Example.org/ ",
    });
    const { buildBootstrapScripts } = await loadBootstrapHost();
    const scripts = await buildBootstrapScripts(baseRow() as any);
    expect(scripts.envLines).toContain(
      "COCALC_PROJECT_CONTENT_DOMAIN=usercontent.example.org",
    );
  });

  it("writes no project content domain when none is configured", async () => {
    const { buildBootstrapScripts } = await loadBootstrapHost();
    const scripts = await buildBootstrapScripts(baseRow() as any);
    expect(
      scripts.envLines.filter((line) =>
        line.startsWith("COCALC_PROJECT_CONTENT_DOMAIN="),
      ),
    ).toEqual([]);
  });

  it("does not send a separate managed harness to bootstrap", async () => {
    const { buildBootstrapScriptWithStatus } = await loadBootstrapHost();
    const script = await buildBootstrapScriptWithStatus(
      baseRow() as any,
      "test-token",
      "https://example.test",
    );
    const match = script.match(
      /bootstrap-desired-state\.json"\n([\s\S]*?)\nEOF_COCALC_BOOTSTRAP_DESIRED_STATE/,
    );
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1])).not.toHaveProperty("managed_harness");
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
    expect(scripts.projectHostFallbackManifestUrl).toBe("");
  });

  it("keeps a desired artifact version the store no longer serves when the host already has it installed", async () => {
    // e.g. a build installed directly on the host: a reboot must not silently
    // move the host to "latest" and back.
    loadEffectiveProjectHostRuntimeDeploymentsMock.mockResolvedValue([
      {
        scope_type: "host",
        scope_id: "host-123",
        target_type: "artifact",
        target: "project-host",
        desired_version: "missing-build",
      },
      {
        scope_type: "global",
        scope_id: "global",
        target_type: "artifact",
        target: "tools",
        desired_version: "missing-build",
      },
      {
        scope_type: "global",
        scope_id: "global",
        target_type: "artifact",
        target: "project-bundle",
        desired_version: "missing-build",
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
            current_version: "missing-build",
            installed_versions: ["missing-build", "older-build"],
          },
          {
            artifact: "tools",
            current_version: "missing-build",
            installed_versions: ["missing-build"],
          },
          {
            // Installed but not current: the version directory still exists.
            artifact: "project-bundle",
            current_version: "older-build",
            installed_versions: ["older-build", "missing-build"],
          },
        ],
      },
    } as any);

    expect(scripts.projectHostVersion).toBe("missing-build");
    expect(scripts.projectHostBundleUrl).toBe(
      `${softwareBaseUrl}/project-host/missing-build/bundle-linux.tar.xz`,
    );
    expect(scripts.projectHostBundleSha256).toBe("");
    expect(scripts.projectBundleVersion).toBe("missing-build");
    // The persisted inventory can be stale (a fresh boot disk after a
    // persistent stop or reprovision): bootstrap falls back to latest if the
    // kept version directory is absent.
    expect(scripts.projectHostFallbackManifestUrl).toBe(
      `${softwareBaseUrl}/project-host/latest-linux.json`,
    );
    expect(scripts.projectBundleFallbackManifestUrl).toBe(
      `${softwareBaseUrl}/project/latest-linux.json`,
    );
    // Tools are never kept without a checksum: the privileged rustic/bees
    // install verifies the archive, so they use the latest manifest.
    expect(scripts.toolsVersion).toBe("tools-latest");
    expect(scripts.toolsSha256).toBe("c".repeat(64));
    expect(scripts.toolsFallbackManifestUrl).toBe("");
  });

  describe("bootstrap launcher with a root-only state root", () => {
    // A token no command may ever print: it must only reach root-only files
    // and the Authorization header.
    const SENTINEL = "SENTINEL-bootstrap-token-7f3c9e1d2a";
    const CA_CERT =
      "-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----";

    function row() {
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
          runtime: { public_ip: "127.0.0.1" },
        },
      };
    }

    // The rendered launcher with its root paths moved into a temp dir, and PATH
    // shims for what needs root or the network. The shims never print their
    // arguments: curl only records whether it was sent the bearer token, and
    // python3 records its argv (no token) to a log file.
    async function renderAndPrepare() {
      const { buildCloudInitStartupScript } = await import("./bootstrap-host");
      const launcher = await buildCloudInitStartupScript(
        row() as any,
        SENTINEL,
        "https://bay.example.test",
        CA_CERT,
        { inlineBootstrapPayload: true },
      );
      const dir = fs.mkdtempSync(path.join(tmpdir(), "bootstrap-launcher-"));
      const state = path.join(dir, "state");
      const shims = path.join(dir, "shims");
      fs.mkdirSync(shims);
      fs.mkdirSync(path.join(dir, "home"));
      fs.mkdirSync(path.join(dir, "var-lib-cocalc"));
      fs.mkdirSync(path.join(dir, "data"));
      const script = launcher
        .split("/var/lib/cocalc-host-bootstrap")
        .join(state)
        .split("/var/lib/cocalc/.bootstrap_done")
        .join(path.join(dir, "var-lib-cocalc", ".bootstrap_done"))
        .split("/mnt/cocalc/data/.bootstrap_done")
        .join(path.join(dir, "data", ".bootstrap_done"));
      fs.writeFileSync(path.join(dir, "launcher.sh"), script);
      const fakeBootstrapPy = path.join(dir, "bootstrap.py.published");
      fs.writeFileSync(fakeBootstrapPy, "print('fake bootstrap')\n");
      const shim = (name: string, body: string) =>
        fs.writeFileSync(path.join(shims, name), `#!/bin/bash\n${body}\n`, {
          mode: 0o755,
        });
      shim(
        "install",
        `args=()
  while [ $# -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac; done
  exec /usr/bin/install "\${args[@]}"`,
      );
      shim(
        "stat",
        `out="$(/usr/bin/stat "$@")" || exit $?
  # as on a host: /var/lib and the state root are root's
  case "$*" in
    *"$SHIM_ROOT"*) printf '%s\\n' "$out" | sed -E 's/^[0-9]+:[0-9]+ /0:0 /' ;;
    *" /var/lib") printf '%s\\n' "$out" | sed -E 's/^[0-9]+:/0:/' ;;
    *var-lib-cocalc/.bootstrap_done) if [ "\${SHIM_LEGACY_ROOT:-0}" = 1 ]; then printf '%s\\n' "$out" | sed -E 's/^[0-9]+:/0:/'; else printf '%s\\n' "$out"; fi ;;
    *var-lib-cocalc) if [ "\${SHIM_LEGACY_ROOT:-0}" = 1 ]; then printf '%s\\n' "$out" | sed -E 's/^[0-9]+:[0-9]+:/0:0:/'; else printf '%s\\n' "$out"; fi ;;
    *) printf '%s\\n' "$out" ;;
  esac`,
      );
      shim(
        "curl",
        `out=""; url=""; auth=0; wfmt=""
  while [ $# -gt 0 ]; do
    case "$1" in
      -o) out="$2"; shift 2 ;;
      -w) wfmt="$2"; shift 2 ;;
      -H) [ "$2" = "Authorization: Bearer $SHIM_TOKEN" ] && auth=1; shift 2 ;;
      --data|-X|--cacert) shift 2 ;;
      -*) shift ;;
      *) url="$1"; shift ;;
    esac
  done
  echo "curl auth=$auth $(basename "$url")" >> "$SHIM_LOG"
  case "$url" in
    */software/*bootstrap.py) if [ "\${SHIM_PRIMARY_FAIL:-0}" = 1 ]; then exit 22; fi; cp "$SHIM_BOOTSTRAP_PY" "$out" ;;
    *.sha256) if [ "\${SHIM_BAD_SHA:-0}" = 1 ]; then echo "0000  bootstrap.py"; else /usr/bin/sha256sum "$SHIM_BOOTSTRAP_PY"; fi ;;
    *bootstrap.py) cp "$SHIM_BOOTSTRAP_PY" "$out" ;;
    *) if [ -n "$out" ]; then : > "$out"; fi; if [ -n "$wfmt" ]; then printf 200; fi ;;
  esac`,
      );
      shim(
        "python3",
        `echo "python3 $*" >> "$SHIM_LOG"
  exit "\${SHIM_PY_RC:-0}"`,
      );
      return { dir, state, shims, fakeBootstrapPy };
    }

    function run(
      ctx: Awaited<ReturnType<typeof renderAndPrepare>>,
      env: Record<string, string>,
    ) {
      const log = path.join(ctx.dir, `shim-${Math.random()}.log`);
      fs.writeFileSync(log, "");
      const result = spawnSync("bash", [path.join(ctx.dir, "launcher.sh")], {
        cwd: ctx.dir,
        encoding: "utf8",
        env: {
          PATH: `${ctx.shims}:/usr/bin:/bin`,
          HOME: path.join(ctx.dir, "home"),
          SHIM_ROOT: ctx.state,
          SHIM_LOG: log,
          SHIM_TOKEN: SENTINEL,
          SHIM_BOOTSTRAP_PY: ctx.fakeBootstrapPy,
          ...env,
        },
      });
      return {
        status: result.status,
        output: `${result.stdout}${result.stderr}`,
        calls: fs.readFileSync(log, "utf8"),
      };
    }

    it("renders scripts bash accepts", async () => {
      const ctx = await renderAndPrepare();
      const check = spawnSync(
        "bash",
        ["-n", path.join(ctx.dir, "launcher.sh")],
        {
          encoding: "utf8",
        },
      );
      expect(check.stderr).toBe("");
      expect(check.status).toBe(0);
    });

    it("reconciles from the root-only state without printing the token", async () => {
      const ctx = await renderAndPrepare();
      fs.mkdirSync(ctx.state, { recursive: true });
      fs.writeFileSync(path.join(ctx.state, ".bootstrap_done"), "");
      const { status, output, calls } = run(ctx, {
        COCALC_BOOTSTRAP_RECONCILE_SCOPE: "helpers",
      });
      expect(output).not.toContain(SENTINEL);
      expect(status).toBe(0);
      // only the verified, root-only copy runs, isolated
      expect(calls).toContain(
        `python3 -I ${ctx.state}/bootstrap/bootstrap.py helpers --bootstrap-dir ${ctx.state}/bootstrap`,
      );
      // the token reaches root-only state only
      expect(
        fs.readFileSync(
          path.join(ctx.state, "bootstrap", "bootstrap-desired-state.json"),
          "utf8",
        ),
      ).toContain(SENTINEL);
      expect(
        fs.readFileSync(
          path.join(ctx.state, "bootstrap", "bootstrap.py"),
          "utf8",
        ),
      ).toBe("print('fake bootstrap')\n");
      // the CA file and the state are in the root-only dir; the payload is gone
      expect(fs.existsSync(path.join(ctx.state, "bootstrap-ca.pem"))).toBe(
        true,
      );
      expect(
        fs
          .readdirSync(path.join(ctx.state, "bootstrap"))
          .filter((name) => name.startsWith("bootstrap.payload")),
      ).toEqual([]);
      for (const sub of ["", "bootstrap", "tmp"]) {
        expect(
          (fs.statSync(path.join(ctx.state, sub)).mode & 0o777).toString(8),
        ).toBe("700");
      }
    });

    it("does not print the token when bootstrap.py fails", async () => {
      const ctx = await renderAndPrepare();
      fs.mkdirSync(ctx.state, { recursive: true });
      fs.writeFileSync(path.join(ctx.state, ".bootstrap_done"), "");
      const { status, output, calls } = run(ctx, {
        COCALC_BOOTSTRAP_RECONCILE_SCOPE: "full",
        SHIM_PY_RC: "1",
      });
      expect(output).not.toContain(SENTINEL);
      expect(status).not.toBe(0);
      expect(calls).toContain("python3 -I");
      expect(calls).toContain("curl auth=1 status");
    });

    it("keeps the previous bootstrap.py and runs nothing on a sha256 mismatch", async () => {
      const ctx = await renderAndPrepare();
      fs.mkdirSync(path.join(ctx.state, "bootstrap"), { recursive: true });
      fs.writeFileSync(path.join(ctx.state, ".bootstrap_done"), "");
      fs.writeFileSync(
        path.join(ctx.state, "bootstrap", "bootstrap.py"),
        "previous\n",
      );
      const { status, output, calls } = run(ctx, {
        COCALC_BOOTSTRAP_RECONCILE_SCOPE: "helpers",
        SHIM_BAD_SHA: "1",
      });
      expect(output).not.toContain(SENTINEL);
      expect(status).not.toBe(0);
      expect(calls).not.toContain("python3");
      expect(
        fs.readFileSync(
          path.join(ctx.state, "bootstrap", "bootstrap.py"),
          "utf8",
        ),
      ).toBe("previous\n");
      expect(
        fs.existsSync(path.join(ctx.state, "bootstrap", "bootstrap.py.new")),
      ).toBe(false);
    });

    it("checks the published sha256 on the bay fallback download too", async () => {
      const ctx = await renderAndPrepare();
      fs.mkdirSync(path.join(ctx.state, "bootstrap"), { recursive: true });
      fs.writeFileSync(path.join(ctx.state, ".bootstrap_done"), "");
      const good = run(ctx, {
        COCALC_BOOTSTRAP_RECONCILE_SCOPE: "helpers",
        SHIM_PRIMARY_FAIL: "1",
      });
      expect(good.output).not.toContain(SENTINEL);
      expect(good.status).toBe(0);
      // the token-authenticated fallback was used, and the sha still checked
      expect(good.calls).toContain("curl auth=1 bootstrap.py");
      expect(good.calls).toContain("bootstrap.py.sha256");
      fs.writeFileSync(
        path.join(ctx.state, "bootstrap", "bootstrap.py"),
        "previous\n",
      );
      const bad = run(ctx, {
        COCALC_BOOTSTRAP_RECONCILE_SCOPE: "helpers",
        SHIM_PRIMARY_FAIL: "1",
        SHIM_BAD_SHA: "1",
      });
      expect(bad.output).not.toContain(SENTINEL);
      expect(bad.status).not.toBe(0);
      expect(bad.calls).not.toContain("python3");
      expect(
        fs.readFileSync(
          path.join(ctx.state, "bootstrap", "bootstrap.py"),
          "utf8",
        ),
      ).toBe("previous\n");
    });

    it("trusts /var/lib/cocalc's marker only while that directory is root's", async () => {
      const ctx = await renderAndPrepare();
      fs.writeFileSync(
        path.join(ctx.dir, "var-lib-cocalc", ".bootstrap_done"),
        "",
      );
      const roots = run(ctx, {
        COCALC_BOOTSTRAP_RECONCILE_SCOPE: "helpers",
        SHIM_LEGACY_ROOT: "1",
      });
      expect(roots.calls).toContain("helpers --bootstrap-dir");
      // a marker that isn't a single root-owned, unshared file is ignored
      const marker = path.join(ctx.dir, "var-lib-cocalc", ".bootstrap_done");
      for (const plant of ["symlink", "hardlink", "writable"]) {
        fs.rmSync(marker, { force: true });
        const real = path.join(ctx.dir, "marker-elsewhere");
        fs.rmSync(real, { force: true });
        fs.writeFileSync(real, "");
        if (plant === "symlink") fs.symlinkSync(real, marker);
        if (plant === "hardlink") fs.linkSync(real, marker);
        if (plant === "writable") {
          fs.writeFileSync(marker, "");
          fs.chmodSync(marker, 0o666);
        }
        const planted = run(ctx, {
          COCALC_BOOTSTRAP_RECONCILE_SCOPE: "helpers",
          SHIM_LEGACY_ROOT: "1",
          SHIM_PY_RC: "1",
        });
        expect(planted.output).toContain("not root's alone");
        expect(planted.calls).not.toContain("helpers --bootstrap-dir");
      }
      fs.rmSync(marker, { force: true });
      fs.writeFileSync(marker, "");
      fs.chmodSync(marker, 0o644);
      // runtime-owned (older hosts): ignored, so first boot runs
      const runtimes = run(ctx, {
        COCALC_BOOTSTRAP_RECONCILE_SCOPE: "helpers",
        SHIM_PY_RC: "1",
      });
      expect(runtimes.output).toContain("not root's alone");
      expect(runtimes.calls).not.toContain("helpers --bootstrap-dir");
      expect(runtimes.calls).toContain(
        `python3 -I ${ctx.state}/bootstrap/bootstrap.py --bootstrap-dir ${ctx.state}/bootstrap`,
      );
    });

    it("does not trust the data disk's marker", async () => {
      const ctx = await renderAndPrepare();
      fs.writeFileSync(path.join(ctx.dir, "data", ".bootstrap_done"), "");
      const { output, calls } = run(ctx, {
        COCALC_BOOTSTRAP_RECONCILE_SCOPE: "helpers",
        SHIM_PY_RC: "1",
      });
      expect(output).not.toContain(SENTINEL);
      expect(output).toContain("ignoring");
      // first boot: bootstrap.py without a reconcile mode
      expect(calls).toContain(
        `python3 -I ${ctx.state}/bootstrap/bootstrap.py --bootstrap-dir ${ctx.state}/bootstrap`,
      );
      expect(calls).not.toContain("helpers --bootstrap-dir");
    });

    it("refuses a state root that is a symlink", async () => {
      const ctx = await renderAndPrepare();
      const elsewhere = path.join(ctx.dir, "elsewhere");
      fs.mkdirSync(elsewhere);
      fs.symlinkSync(elsewhere, ctx.state);
      const { status, output, calls } = run(ctx, {
        COCALC_BOOTSTRAP_RECONCILE_SCOPE: "helpers",
      });
      expect(status).not.toBe(0);
      expect(output).toContain("a symlink");
      expect(output).not.toContain(SENTINEL);
      expect(calls).not.toContain("python3");
      expect(fs.readdirSync(elsewhere)).toEqual([]);
    });
  });
});
