/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let getServerSettingsMock: jest.Mock;

jest.mock("@cocalc/database/settings/server-settings", () => ({
  __esModule: true,
  getServerSettings: (...args: any[]) => getServerSettingsMock(...args),
}));

describe("ensureCloudflareTunnelForHost", () => {
  beforeEach(() => {
    jest.resetModules();
    getServerSettingsMock = jest.fn(async () => ({}));
  });

  it("reuses existing tunnel metadata when the current bay cannot manage Cloudflare", async () => {
    const existing = {
      id: "tunnel-id",
      name: "cocalc-host-host-123",
      hostname: "host-host-123.example.test",
      ssh_hostname: "ssh-host-host-123.example.test",
      tunnel_secret: "secret",
      account_id: "account-id",
      token: "token",
    };
    const { ensureCloudflareTunnelForHost } =
      await import("./cloudflare-tunnel");

    await expect(
      ensureCloudflareTunnelForHost({
        host_id: "host-123",
        existing,
      }),
    ).resolves.toBe(existing);
  });

  it("expands bare project-host suffix settings before creating dns records", async () => {
    getServerSettingsMock = jest.fn(async () => ({
      cloudflare_mode: "self",
      dns: "lite2b.cocalc.ai",
      project_hosts_cloudflare_tunnel_account_id: "account-id",
      project_hosts_cloudflare_tunnel_api_token: "token",
      project_hosts_cloudflare_tunnel_host_suffix: "lite2b",
    }));
    const fetchMock = jest.fn(async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/zones?")) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            result: [{ name: "cocalc.ai", id: "zone-id" }],
          }),
        };
      }
      if (init?.method === "POST" && url.includes("/cfd_tunnel")) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            result: {
              id: "tunnel-id",
              name: "tunnel-name",
              tunnel_secret: "tunnel-secret",
            },
          }),
        };
      }
      if (init?.method === "GET" && url.includes("/dns_records?")) {
        return {
          ok: true,
          json: async () => ({ success: true, result: [] }),
        };
      }
      if (init?.method === "POST" && url.includes("/dns_records")) {
        return {
          ok: true,
          json: async () => ({ success: true, result: { id: "record-id" } }),
        };
      }
      if (init?.method === "PUT" && url.includes("/dns_records/record-id")) {
        return {
          ok: true,
          json: async () => ({ success: true, result: { id: "record-id" } }),
        };
      }
      if (init?.method === "GET" && url.includes("/token")) {
        return {
          ok: true,
          json: async () => ({ success: true, result: "connector-token" }),
        };
      }
      return {
        ok: true,
        json: async () => ({ success: true, result: {} }),
      };
    });
    (global as any).fetch = fetchMock;

    const { ensureCloudflareTunnelForHost } =
      await import("./cloudflare-tunnel");
    await ensureCloudflareTunnelForHost({ host_id: "abc" });

    const recordNames = fetchMock.mock.calls
      .map(([, init]) => init?.body)
      .filter(Boolean)
      .map((body) => JSON.parse(String(body)).name)
      .filter(Boolean);
    expect(recordNames).toContain("host-abc-lite2b.cocalc.ai");
    expect(recordNames).toContain("ssh-host-abc-lite2b.cocalc.ai");
    expect(recordNames).not.toContain("host-abc-lite2b");
  });
});
