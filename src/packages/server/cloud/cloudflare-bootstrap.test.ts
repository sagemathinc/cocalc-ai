/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

function jsonResponse(result: any) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ success: true, result }),
  } as Response;
}

describe("bootstrapCloudflareConfiguration", () => {
  beforeEach(() => {
    jest.resetModules();
    global.fetch = jest.fn();
  });

  it("discovers Cloudflare config, creates a durable token, enables location headers, and invalidates the bootstrap token", async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ id: "bootstrap-id", status: "active" }),
      )
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: "zone-id",
            name: "example.edu",
            account: { id: "account-id", name: "Example Account" },
          },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: "tunnel-write",
            name: "Cloudflare Tunnel Write",
            scopes: ["com.cloudflare.api.account"],
          },
          {
            id: "zone-read",
            name: "Zone Read",
            scopes: ["com.cloudflare.api.account.zone"],
          },
          {
            id: "dns-write",
            name: "DNS Write",
            scopes: ["com.cloudflare.api.account.zone"],
          },
          {
            id: "managed-headers-write",
            name: "Managed headers Write",
            scopes: ["com.cloudflare.api.account.zone"],
          },
          {
            id: "r2-write",
            name: "Workers R2 Storage Write",
            scopes: ["com.cloudflare.api.account"],
          },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse({ id: "durable-id", value: "durable-token" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          managed_request_headers: [
            { id: "add_visitor_location_headers", enabled: false },
          ],
          managed_response_headers: [],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          managed_request_headers: [
            { id: "add_visitor_location_headers", enabled: true },
          ],
          managed_response_headers: [],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "bootstrap-id" }));

    const { bootstrapCloudflareConfiguration } =
      await import("./cloudflare-bootstrap");

    const result = await bootstrapCloudflareConfiguration({
      domain: "cocalc.example.edu",
      token: "bootstrap-token",
      tunnelPrefix: "cocalc",
      r2BucketPrefix: "test",
    });

    expect(result.account_id).toBe("account-id");
    expect(result.zone_name).toBe("example.edu");
    expect(result.values.project_hosts_cloudflare_tunnel_api_token).toBe(
      "durable-token",
    );
    expect(result.values.r2_api_token).toBe("durable-token");
    expect(result.visitor_location_headers.ok).toBe(true);
    expect(result.bootstrap_token_invalidated).toBe(true);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://api.cloudflare.com/client/v4/user/tokens/bootstrap-id",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
