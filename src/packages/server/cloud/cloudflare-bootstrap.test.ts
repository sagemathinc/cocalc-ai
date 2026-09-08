/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { bootstrapCloudflareConfiguration } from "./cloudflare-bootstrap";

const accountScope = "com.cloudflare.api.account";
const zoneScope = "com.cloudflare.api.account.zone";
const groups = [
  ...[
    "Cloudflare Tunnel Write",
    "Workers Scripts Write",
    "Workers R2 Storage Write",
    "Account Analytics Read",
  ].map((name) => ({ id: name, name, scopes: [accountScope] })),
  ...[
    "Zone Read",
    "DNS Write",
    "Workers Routes Write",
    "Config Settings Write",
    "Managed headers Write",
  ].map((name) => ({ id: name, name, scopes: [zoneScope] })),
  {
    id: "forbidden",
    name: "API Tokens Write",
    scopes: ["com.cloudflare.api.user"],
  },
];
function response(result: unknown, status = 200): Response {
  return {
    ok: status === 200,
    status,
    json: async () => ({
      success: status === 200,
      result,
      errors: [
        { message: "echo bootstrap-secret durable-secret discovery-secret" },
      ],
    }),
  } as Response;
}

describe("Cloudflare bootstrap secret lifecycle", () => {
  let save: jest.Mock;
  let fetchMock: jest.Mock;
  beforeEach(() => {
    save = jest.fn().mockResolvedValue(undefined);
    fetchMock = jest.fn(async (url: string, init: RequestInit) => {
      const path = url.replace("https://api.cloudflare.com/client/v4/", "");
      const auth = (init.headers as Record<string, string>).Authorization;
      if (path === "user/tokens/verify")
        return response({ id: "bootstrap-id", status: "active" });
      if (path === "user/tokens/permission_groups") return response(groups);
      if (path === "user/tokens" && init.method === "POST") {
        const body = JSON.parse(init.body as string);
        if (body.expires_on)
          return response({ id: "discovery-id", value: "discovery-secret" });
        return response({ id: "durable-id", value: "durable-secret" });
      }
      if (path.startsWith("zones?")) {
        expect(auth).toBe("Bearer discovery-secret");
        return response([
          { id: "zone-id", name: "example.edu", account: { id: "account-id" } },
        ]);
      }
      if (path.endsWith("managed_headers")) {
        expect(auth).toBe("Bearer durable-secret");
        return response({
          managed_request_headers: [
            { id: "add_visitor_location_headers", enabled: true },
          ],
        });
      }
      if (init.method === "DELETE") return response({});
      throw new Error("unexpected path");
    });
    global.fetch = fetchMock;
  });

  const run = (save: jest.Mock) =>
    bootstrapCloudflareConfiguration({
      domain: "example.edu",
      token: "bootstrap-secret",
      r2BucketPrefix: "site",
      save,
    });

  it("saves scoped credentials only on the server, revokes temporary tokens, and uses the durable token for configuration", async () => {
    const result = await run(save);
    expect(result.tunnel_token.ok).toBe(true);
    expect(result.bootstrap_token_invalidated).toBe(true);
    expect(result.permissions).toContain("Workers Scripts Write");
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        r2_api_token: "durable-secret",
        project_hosts_cloudflare_tunnel_api_token: "durable-secret",
      }),
    );
    for (const secret of [
      "bootstrap-secret",
      "discovery-secret",
      "durable-secret",
    ]) {
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    expect(JSON.stringify(save.mock.calls)).not.toContain("bootstrap-secret");
    expect(JSON.stringify(save.mock.calls)).not.toContain("discovery-secret");
    const policies = fetchMock.mock.calls
      .filter(
        ([url, init]) => url.endsWith("/user/tokens") && init.method === "POST",
      )
      .map(([, init]) => JSON.parse(init.body));
    expect(policies[0].expires_on).toBeDefined();
    expect(policies[0].policies[0].permission_groups).toEqual([
      { id: "Zone Read" },
    ]);
    expect(policies[1].policies.map((p) => p.resources)).toEqual([
      { "com.cloudflare.api.account.account-id": "*" },
      { "com.cloudflare.api.account.zone.zone-id": "*" },
    ]);
    expect(JSON.stringify(policies[1])).not.toContain("forbidden");
    expect(
      fetchMock.mock.calls
        .filter(([, init]) => init.method === "DELETE")
        .map(([url]) => url.split("/").pop()),
    ).toEqual(["discovery-id", "bootstrap-id"]);
  });

  it("redacts provider errors and saves nothing if creation fails", async () => {
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) => {
      if (url.endsWith("/user/tokens") && !JSON.parse(init.body).expires_on)
        return response({}, 403);
      return normal(url, init);
    });
    const result = await run(save);
    expect(result.tunnel_token.ok).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result.bootstrap_token_invalidated).toBe(true);
  });

  it("reports revocation failure without leaking echoed secrets", async () => {
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) =>
      init.method === "DELETE" ? response({}, 403) : normal(url, init),
    );
    const result = await run(save);
    expect(result.tunnel_token.ok).toBe(true);
    expect(result.bootstrap_token_invalidated).toBe(false);
    expect(result.notes.join(" ")).toContain("discovery-id");
    expect(result.bootstrap_token_invalidation_error).toContain("manually");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("keeps a possibly saved token usable after ambiguous persistence failure", async () => {
    save.mockRejectedValue(new Error("database error with durable-secret"));
    const result = await run(save);
    expect(result.tunnel_token.ok).toBe(false);
    expect(result.notes.join(" ")).toContain("durable-id");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          init.method === "DELETE" && url.endsWith("/durable-id"),
      ),
    ).toBe(false);
  });

  it("does not configure anything if domain validation fails", async () => {
    await expect(
      bootstrapCloudflareConfiguration({
        domain: "bad",
        token: "bootstrap-secret",
        save,
      }),
    ).rejects.toThrow("valid");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
