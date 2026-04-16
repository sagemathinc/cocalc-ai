/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

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
      if (path.endsWith(".sha256")) {
        sendText(`${"d".repeat(64)}  ${path.split("/").at(-1) ?? "bundle"}`);
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as AddressInfo;
    softwareBaseUrl = `http://127.0.0.1:${address.port}/software`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  beforeEach(() => {
    jest.resetModules();
    process.env.MASTER_CONAT_SERVER = "http://master.example.test";
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
    expect(scripts.bootstrapSelector).toBe("bootstrap-v5");
    expect(scripts.bootstrapPyUrl).toBe(
      `${softwareBaseUrl}/bootstrap/bootstrap-v5/bootstrap.py`,
    );
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
    expect(scripts.bootstrapSelector).toBe("latest");
  });
});
