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

    const tokenFetch = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/token"),
    );
    expect(tokenFetch?.[1]?.signal).toBeInstanceOf(AbortSignal);

    const recordNames = fetchMock.mock.calls
      .map(([, init]) => init?.body)
      .filter(Boolean)
      .map((body) => JSON.parse(String(body)).name)
      .filter(Boolean);
    expect(recordNames).toContain("host-abc-lite2b.cocalc.ai");
    expect(recordNames).toContain("ssh-host-abc-lite2b.cocalc.ai");
    expect(recordNames).not.toContain("host-abc-lite2b");
  });

  it("retains the tunnel and ssh dns without replacing direct browser dns", async () => {
    getServerSettingsMock = jest.fn(async () => ({
      cloudflare_mode: "self",
      dns: "staging.example.test",
      project_hosts_cloudflare_tunnel_account_id: "account-id",
      project_hosts_cloudflare_tunnel_api_token: "token",
      project_hosts_cloudflare_tunnel_host_suffix: "staging.example.test",
    }));
    const fetchMock = jest.fn(async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/zones?")) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            result: [{ name: "example.test", id: "zone-id" }],
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
          json: async () => ({ success: true, result: { id: "ssh-record" } }),
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
    const result = await ensureCloudflareTunnelForHost({
      host_id: "abc",
      publish_browser_dns: false,
    });

    const recordNames = fetchMock.mock.calls
      .map(([, init]) => init?.body)
      .filter(Boolean)
      .map((body) => JSON.parse(String(body)).name)
      .filter(Boolean);
    expect(recordNames).not.toContain("host-abc-staging.example.test");
    expect(recordNames).toContain("ssh-host-abc-staging.example.test");
    expect(result).toMatchObject({
      id: "tunnel-id",
      record_id: undefined,
      ssh_record_id: "ssh-record",
    });
  });

  it("adopts an active same-name tunnel when local metadata was lost", async () => {
    getServerSettingsMock = jest.fn(async () => ({
      cloudflare_mode: "self",
      dns: "staging.example.test",
      project_hosts_cloudflare_tunnel_account_id: "account-id",
      project_hosts_cloudflare_tunnel_api_token: "token",
      project_hosts_cloudflare_tunnel_host_suffix: "staging.example.test",
    }));
    const fetchMock = jest.fn(async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/zones?")) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            result: [{ name: "example.test", id: "zone-id" }],
          }),
        };
      }
      if (init?.method === "POST" && url.includes("/cfd_tunnel")) {
        return {
          ok: false,
          status: 409,
          statusText: "Conflict",
          text: async () =>
            JSON.stringify({
              success: false,
              errors: [{ message: "tunnel name already exists" }],
            }),
        };
      }
      if (init?.method === "GET" && url.includes("/cfd_tunnel?")) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            result: [
              {
                id: "existing-tunnel-id",
                name: "host-abc",
                deleted_at: null,
              },
            ],
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
          json: async () => ({ success: true, result: { id: "ssh-record" } }),
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
    const result = await ensureCloudflareTunnelForHost({
      host_id: "abc",
      publish_browser_dns: false,
    });

    expect(result).toMatchObject({
      id: "existing-tunnel-id",
      token: "connector-token",
      ssh_record_id: "ssh-record",
    });
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(false);
  });

  it("preserves apex non-address records when creating the hub tunnel cname", async () => {
    getServerSettingsMock = jest.fn(async () => ({
      cloudflare_mode: "self",
      dns: "cocalc.ai",
      project_hosts_cloudflare_tunnel_account_id: "account-id",
      project_hosts_cloudflare_tunnel_api_token: "token",
      project_hosts_cloudflare_tunnel_prefix: "cocalc-prod",
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
              name: "cocalc-prod-hub-cocalc-ai",
              tunnel_secret: "tunnel-secret",
            },
          }),
        };
      }
      if (init?.method === "GET" && url.includes("/dns_records?")) {
        if (url.includes("type=CNAME")) {
          return {
            ok: true,
            json: async () => ({ success: true, result: [] }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            success: true,
            result: [
              { id: "record-a", name: "cocalc.ai", type: "A" },
              { id: "record-mx", name: "cocalc.ai", type: "MX" },
              { id: "record-txt", name: "cocalc.ai", type: "TXT" },
              { id: "record-caa", name: "cocalc.ai", type: "CAA" },
            ],
          }),
        };
      }
      if (init?.method === "DELETE") {
        return {
          ok: true,
          json: async () => ({ success: true, result: {} }),
        };
      }
      if (init?.method === "POST" && url.includes("/dns_records")) {
        return {
          ok: true,
          json: async () => ({ success: true, result: { id: "record-cname" } }),
        };
      }
      if (init?.method === "PUT" && url.includes("/dns_records/record-cname")) {
        return {
          ok: true,
          json: async () => ({ success: true, result: { id: "record-cname" } }),
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

    const { ensureCloudflareTunnelForHub } =
      await import("./cloudflare-tunnel");
    const tunnel = await ensureCloudflareTunnelForHub();

    expect(tunnel?.hostname).toBe("cocalc.ai");
    const deletedIds = fetchMock.mock.calls
      .filter(([, init]) => init?.method === "DELETE")
      .map(([url]) => String(url).split("/dns_records/")[1]);
    expect(deletedIds).toContain("record-a");
    expect(deletedIds).not.toContain("record-mx");
    expect(deletedIds).not.toContain("record-txt");
    expect(deletedIds).not.toContain("record-caa");
  });
});

describe("deleteCloudflareTunnel", () => {
  beforeEach(() => {
    jest.resetModules();
    getServerSettingsMock = jest.fn(async () => ({
      cloudflare_mode: "self",
      dns: "staging.example.test",
      project_hosts_cloudflare_tunnel_account_id: "account-id",
      project_hosts_cloudflare_tunnel_api_token: "token",
      project_hosts_cloudflare_tunnel_host_suffix: "staging.example.test",
    }));
  });

  it("removes exact-name records when stored record ids are stale", async () => {
    const fetchMock = jest.fn(async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/zones?")) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            result: [{ name: "example.test", id: "zone-id" }],
          }),
        };
      }
      if (
        init?.method === "DELETE" &&
        (url.endsWith("/stale-browser-id") || url.endsWith("/stale-ssh-id"))
      ) {
        return {
          ok: false,
          status: 404,
          statusText: "Not Found",
          text: async () => "not found",
        };
      }
      if (init?.method === "GET" && url.includes("/dns_records?")) {
        const name = new URL(url).searchParams.get("name");
        return {
          ok: true,
          json: async () => ({
            success: true,
            result: [
              {
                id: name?.startsWith("ssh-")
                  ? "current-ssh-id"
                  : "current-browser-id",
              },
            ],
          }),
        };
      }
      if (init?.method === "GET" && url.includes("/cfd_tunnel?")) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            result: [{ id: "current-tunnel-id", name: "host-abc" }],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ success: true, result: {} }),
      };
    });
    (global as any).fetch = fetchMock;

    const { deleteCloudflareTunnel } = await import("./cloudflare-tunnel");
    await deleteCloudflareTunnel({
      host_id: "abc",
      tunnel: {
        id: "tunnel-id",
        name: "host-abc",
        hostname: "host-abc-staging.example.test",
        ssh_hostname: "ssh-host-abc-staging.example.test",
        tunnel_secret: "secret",
        account_id: "account-id",
        record_id: "stale-browser-id",
        ssh_record_id: "stale-ssh-id",
      },
    });

    const deletedUrls = fetchMock.mock.calls
      .filter(([, init]) => init?.method === "DELETE")
      .map(([url]) => String(url));
    expect(deletedUrls).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/dns_records/stale-browser-id"),
        expect.stringContaining("/dns_records/current-browser-id"),
        expect.stringContaining("/dns_records/stale-ssh-id"),
        expect.stringContaining("/dns_records/current-ssh-id"),
        expect.stringContaining("/cfd_tunnel/tunnel-id/connections"),
        expect.stringContaining("/cfd_tunnel/tunnel-id"),
        expect.stringContaining("/cfd_tunnel/current-tunnel-id/connections"),
        expect.stringContaining("/cfd_tunnel/current-tunnel-id"),
      ]),
    );
  });

  it("discovers tunnel and dns resources when host metadata was lost", async () => {
    const fetchMock = jest.fn(async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/zones?")) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            result: [{ name: "example.test", id: "zone-id" }],
          }),
        };
      }
      if (init?.method === "GET" && url.includes("/dns_records?")) {
        const name = new URL(url).searchParams.get("name");
        return {
          ok: true,
          json: async () => ({
            success: true,
            result: [{ id: name?.startsWith("ssh-") ? "ssh-id" : "web-id" }],
          }),
        };
      }
      if (init?.method === "GET" && url.includes("/cfd_tunnel?")) {
        expect(new URL(url).searchParams.get("name")).toBe("host-abc");
        return {
          ok: true,
          json: async () => ({
            success: true,
            result: [{ id: "discovered-tunnel-id", name: "host-abc" }],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ success: true, result: {} }),
      };
    });
    (global as any).fetch = fetchMock;

    const { deleteCloudflareTunnel } = await import("./cloudflare-tunnel");
    await deleteCloudflareTunnel({ host_id: "abc" });

    const deletedUrls = fetchMock.mock.calls
      .filter(([, init]) => init?.method === "DELETE")
      .map(([url]) => String(url));
    expect(deletedUrls).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/dns_records/web-id"),
        expect.stringContaining("/dns_records/ssh-id"),
        expect.stringContaining("/cfd_tunnel/discovered-tunnel-id/connections"),
        expect.stringContaining("/cfd_tunnel/discovered-tunnel-id"),
      ]),
    );
  });

  it("publishes an additional hostname on an existing hub tunnel", async () => {
    getServerSettingsMock = jest.fn(async () => ({
      cloudflare_mode: "self",
      dns: "lite2b.cocalc.ai",
      project_hosts_cloudflare_tunnel_account_id: "account-id",
      project_hosts_cloudflare_tunnel_api_token: "token",
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
      if (init?.method === "GET" && url.includes("/dns_records?")) {
        return {
          ok: true,
          json: async () => ({ success: true, result: [] }),
        };
      }
      if (init?.method === "POST" && url.includes("/dns_records")) {
        return {
          ok: true,
          json: async () => ({ success: true, result: { id: "approval-id" } }),
        };
      }
      return {
        ok: true,
        json: async () => ({ success: true, result: {} }),
      };
    });
    (global as any).fetch = fetchMock;

    const { ensureCloudflareTunnelHostname } =
      await import("./cloudflare-tunnel");
    await ensureCloudflareTunnelHostname({
      tunnel: {
        id: "tunnel-id",
        name: "hub-lite2b",
        hostname: "lite2b.cocalc.ai",
        tunnel_secret: "secret",
        account_id: "account-id",
      },
      hostname: "approve.lite2b.cocalc.ai",
    });

    const written = fetchMock.mock.calls
      .map(([, init]) => init?.body)
      .filter(Boolean)
      .map((body) => JSON.parse(String(body)));
    expect(written).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "approve.lite2b.cocalc.ai",
          content: "tunnel-id.cfargotunnel.com",
          proxied: true,
        }),
      ]),
    );
  });
});
