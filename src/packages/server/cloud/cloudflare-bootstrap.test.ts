/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { bootstrapCloudflareConfiguration } from "./cloudflare-bootstrap";
import { createHash } from "node:crypto";
import getLogger from "@cocalc/backend/logger";

jest.mock("@cocalc/backend/logger", () => {
  const logger = { warn: jest.fn() };
  return { __esModule: true, default: () => logger };
});

const accountScope = "com.cloudflare.api.account";
const zoneScope = "com.cloudflare.api.account.zone";
const groups = [
  {
    id: "s3-objects-write",
    name: "Workers R2 Storage Bucket Item Write",
    scopes: ["com.cloudflare.edge.r2.bucket"],
  },
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
    jest.clearAllMocks();
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
        if (body.name.startsWith("CoCalc R2 objects"))
          return response({ id: "s3-id", value: "s3-secret" });
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
        r2_access_key_id: "s3-id",
        r2_secret_access_key: createHash("sha256")
          .update("s3-secret")
          .digest("hex"),
      }),
    );
    for (const secret of [
      "bootstrap-secret",
      "discovery-secret",
      "durable-secret",
      "s3-secret",
      createHash("sha256").update("s3-secret").digest("hex"),
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
    expect(policies[2].policies).toEqual([
      {
        effect: "allow",
        permission_groups: [{ id: "s3-objects-write" }],
        resources: Object.fromEntries(
          ["wnam", "enam", "weur", "eeur", "apac", "oc", "blobs"].map(
            (suffix) => [
              `com.cloudflare.edge.r2.bucket.account-id_default_site-${suffix}`,
              "*",
            ],
          ),
        ),
      },
    ]);
    expect(policies[2]).not.toHaveProperty("expires_on");
    expect(result.r2.ok).toBe(true);
    expect(result.values.r2_access_key_id).toBe("s3-id");
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
    expect(result.settings_status).toBe("not_saved");
    expect(result.failure).toContain("HTTP 403");
  });

  it.each([
    [{ status: "expired" }, "has expired"],
    [{ status: "disabled" }, "is disabled"],
    [{ status: "active", expires_on: "2000-01-01T00:00:00Z" }, "has expired"],
    [{ status: "active", not_before: "2999-01-01T00:00:00Z" }, "not valid yet"],
    [{ status: "echo bootstrap-secret" }, "did not confirm"],
  ])(
    "reports token validity without running later steps: %j",
    async (verification, message) => {
      fetchMock.mockResolvedValueOnce(response(verification));
      const result = await run(save);
      expect(result.failure).toContain(message);
      expect(result.settings_status).toBe("not_saved");
      expect(save).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toContain("bootstrap-secret");
      expect(
        JSON.stringify((getLogger("").warn as jest.Mock).mock.calls),
      ).not.toContain("bootstrap-secret");
    },
  );

  it("exposes numeric provider diagnostics but never response text or network errors", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({
        success: false,
        errors: [
          { code: 1000, message: "bootstrap-secret" },
          { code: "bootstrap-secret", message: "bootstrap-secret" },
        ],
      }),
    });
    const rejected = await run(save);
    expect(rejected.failure).toContain("HTTP 401; codes 1000");
    fetchMock.mockRejectedValueOnce(new Error("network bootstrap-secret"));
    const network = await run(save);
    expect(network.failure).toContain("could not be reached");
    expect(save).not.toHaveBeenCalled();
    expect(
      JSON.stringify([
        rejected,
        network,
        (getLogger("").warn as jest.Mock).mock.calls,
      ]),
    ).not.toContain("bootstrap-secret");
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
    expect(result.settings_status).toBe("unknown");
    expect(result.notes.join(" ")).toContain("s3-id");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          init.method === "DELETE" &&
          (url.endsWith("/durable-id") || url.endsWith("/s3-id")),
      ),
    ).toBe(false);
  });

  const existingR2 = {
    accountId: "account-id",
    accessKey: "existing-id",
    secretKey: "existing-secret",
    bucketPrefix: "site",
  };

  it("preserves an existing credential pair on repeat bootstrap", async () => {
    const result = await bootstrapCloudflareConfiguration({
      domain: "example.edu",
      token: "bootstrap-secret",
      r2BucketPrefix: "site",
      existingR2,
      save,
    });
    expect(result.r2.ok).toBe(true);
    expect(result.r2.message).toContain("preserved");
    expect(save.mock.calls[0][0].r2_access_key_id).toBe("existing-id");
    expect(save.mock.calls[0][0]).not.toHaveProperty("r2_secret_access_key");
    expect(JSON.stringify(result)).not.toContain("existing-secret");
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => url.endsWith("/user/tokens") && init.method === "POST",
      ),
    ).toHaveLength(2);
  });

  it.each([
    { accountId: "another-account" },
    { bucketPrefix: "another-prefix" },
    { secretKey: "" },
    { accessKey: "" },
  ])(
    "refuses to replace or retarget existing credentials: %j",
    async (changes) => {
      const result = await bootstrapCloudflareConfiguration({
        domain: "example.edu",
        token: "bootstrap-secret",
        r2BucketPrefix: "site",
        existingR2: { ...existingR2, ...changes },
        save,
      });
      expect(result.tunnel_token.ok).toBe(false);
      expect(result.notes.join(" ")).toContain("No settings were changed");
      expect(save).not.toHaveBeenCalled();
      expect(result.bootstrap_token_invalidated).toBe(true);
    },
  );

  it("uses the configured custom blob bucket without granting account-wide S3 access", async () => {
    await bootstrapCloudflareConfiguration({
      domain: "example.edu",
      token: "bootstrap-secret",
      r2BucketPrefix: "site",
      existingR2: { blobBucket: "custom-images" },
      save,
    });
    const body = fetchMock.mock.calls
      .filter(
        ([url, init]) => url.endsWith("/user/tokens") && init.method === "POST",
      )
      .map(([, init]) => JSON.parse(init.body))
      .at(-1);
    expect(Object.keys(body.policies[0].resources)).toContain(
      "com.cloudflare.edge.r2.bucket.account-id_default_custom-images",
    );
    expect(Object.keys(body.policies[0].resources)).not.toContain(
      "com.cloudflare.edge.r2.bucket.account-id_default_site-blobs",
    );
  });

  it("cleans up the unsaved automation token if S3 creation fails", async () => {
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) => {
      if (
        init.method === "POST" &&
        JSON.parse(init.body).name.startsWith("CoCalc R2 objects")
      )
        return response({}, 403);
      return normal(url, init);
    });
    const result = await run(save);
    expect(save).not.toHaveBeenCalled();
    expect(result.r2.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(
      fetchMock.mock.calls
        .filter(([, init]) => init.method === "DELETE")
        .map(([url]) => url.split("/").pop()),
    ).toEqual(["discovery-id", "durable-id", "bootstrap-id"]);
  });

  it("fails closed if the bucket-scoped permission is unavailable", async () => {
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) => {
      if (url.endsWith("/permission_groups"))
        return response(
          groups.filter((group) => group.id !== "s3-objects-write"),
        );
      return normal(url, init);
    });
    const result = await run(save);
    expect(result.failure).toContain("Workers R2 Storage Bucket Item Write");
    expect(result.r2.ok).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => url.endsWith("/user/tokens") && init.method === "POST",
      ),
    ).toHaveLength(2);
  });

  it("distinguishes a missing Zone Read permission from discovery token creation failure", async () => {
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) => {
      if (url.endsWith("/permission_groups"))
        return response(groups.filter((group) => group.name !== "Zone Read"));
      return normal(url, init);
    });
    const result = await run(save);
    expect(result.failure).toContain(
      "Unable to resolve the Zone Read permission",
    );
    expect(result.failure).toContain("permission group not found: Zone Read");
    expect(result.settings_status).toBe("not_saved");
    expect(result.bootstrap_token_invalidated).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.some(([, init]) => init.method === "POST"),
    ).toBe(false);
  });

  it("reports a rejected discovery token creation without proceeding to settings", async () => {
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) => {
      if (init.method === "POST") return response({}, 400);
      return normal(url, init);
    });
    const result = await run(save);
    expect(result.failure).toContain(
      "Unable to create a temporary zone discovery token",
    );
    expect(result.failure).toContain("HTTP 400");
    expect(result.settings_status).toBe("not_saved");
    expect(result.bootstrap_token_invalidated).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("revokes a malformed S3 token response rather than saving incomplete credentials", async () => {
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) => {
      if (
        init.method === "POST" &&
        JSON.parse(init.body).name.startsWith("CoCalc R2 objects")
      )
        return response({ id: "incomplete-s3-id" });
      return normal(url, init);
    });
    const result = await run(save);
    expect(result.tunnel_token.ok).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls
        .filter(([, init]) => init.method === "DELETE")
        .map(([url]) => url.split("/").pop()),
    ).toContain("incomplete-s3-id");
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
