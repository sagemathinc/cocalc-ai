let fetchMock: jest.Mock;
let mockedSettings: {
  project_hosts_cloudflare_tunnel_api_token: string;
  dns?: string;
  public_viewer_dns?: string;
};

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: jest.fn(async () => mockedSettings),
}));

const zoneResponse = {
  ok: true,
  json: async () => ({
    success: true,
    result: [{ name: "example.com", id: "zone-1" }],
  }),
};

function responseWith(result: any) {
  return {
    ok: true,
    json: async () => ({
      success: true,
      result,
    }),
  };
}

describe("cloud dns", () => {
  beforeEach(() => {
    jest.resetModules();
    mockedSettings = {
      project_hosts_cloudflare_tunnel_api_token: "token",
      dns: "https://dev.example.com",
      public_viewer_dns: "",
    };
    fetchMock = jest.fn(async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/zones?")) {
        return zoneResponse;
      }
      if (init?.method === "GET" && url.includes("/dns_records?")) {
        return responseWith([]);
      }
      if (init?.method === "POST" && url.includes("/dns_records")) {
        return responseWith({ id: "record-1" });
      }
      if (init?.method === "PUT" && url.includes("/dns_records/record-xyz")) {
        return responseWith({ id: "record-xyz" });
      }
      if (init?.method === "DELETE") {
        return responseWith({ id: "record-1" });
      }
      return responseWith({});
    });
    (global as any).fetch = fetchMock;
  });

  it("falls back to the parent Cloudflare zone for subdomain-based host dns", async () => {
    mockedSettings = {
      project_hosts_cloudflare_tunnel_api_token: "token",
      dns: "dev.example.com",
    };
    fetchMock = jest.fn(async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/zones?")) {
        if (url.includes("name=host-abc-dev.example.com")) {
          return responseWith([]);
        }
        if (url.includes("name=example.com")) {
          return responseWith([{ name: "example.com", id: "zone-parent" }]);
        }
      }
      if (init?.method === "GET" && url.includes("/dns_records?")) {
        return responseWith([]);
      }
      if (init?.method === "POST" && url.includes("/dns_records")) {
        return responseWith({ id: "record-parent" });
      }
      return responseWith({});
    });
    (global as any).fetch = fetchMock;

    const { ensureHostDns } = await import("./dns");
    const result = await ensureHostDns({
      host_id: "abc",
      ipAddress: "203.0.113.8",
    });

    expect(result.name).toBe("host-abc-dev.example.com");
    expect(result.record_id).toBe("record-parent");
    const zoneCalls = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes("/zones?"));
    expect(
      zoneCalls.some((url) => url.includes("name=host-abc-dev.example.com")),
    ).toBe(true);
    expect(zoneCalls.some((url) => url.includes("name=example.com"))).toBe(
      true,
    );
  });

  it("creates a proxied A record for the host", async () => {
    const { ensureHostDns } = await import("./dns");
    const result = await ensureHostDns({
      host_id: "abc",
      ipAddress: "203.0.113.5",
    });
    expect(result.name).toBe("host-abc-dev.example.com");
    expect(result.record_id).toBe("record-1");

    const addCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes("/dns_records") && init?.method === "POST",
    );
    const record = addCall?.[1]?.body ? JSON.parse(addCall[1].body) : undefined;
    expect(record.type).toBe("A");
    expect(record.content).toBe("203.0.113.5");
    expect(record.name).toBe("host-abc-dev.example.com");
    expect(record.proxied).toBe(true);
  });

  it("reads the Cloudflare zone SSL mode without exposing credentials", async () => {
    fetchMock.mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("/zones?")) return zoneResponse;
      if (url.includes("/settings/ssl")) {
        return responseWith({
          value: "full",
          editable: true,
          modified_on: "2026-07-21T00:00:00Z",
        });
      }
      return responseWith({});
    });
    (global as any).fetch = fetchMock;

    const { getCloudflareZoneSslMode } = await import("./dns");
    await expect(
      getCloudflareZoneSslMode("host-abc-dev.example.com"),
    ).resolves.toEqual({
      value: "full",
      editable: true,
      modified_on: "2026-07-21T00:00:00Z",
    });
  });

  it("derives one zone-wide SSL rule for prod and staging hostnames", async () => {
    const { projectHostSslRuleExpression } = await import("./dns");
    const prod = projectHostSslRuleExpression({
      hostname:
        "host-7bd699f8-e20b-4b13-9dfa-f7358f85544e-cocalc-prod.cocalc.ai",
      hostId: "7bd699f8-e20b-4b13-9dfa-f7358f85544e",
    });
    const staging = projectHostSslRuleExpression({
      hostname:
        "host-99838afd-80f3-4e5b-96b8-7aff05ba9452-cocalc-staging.cocalc.ai",
      hostId: "99838afd-80f3-4e5b-96b8-7aff05ba9452",
    });

    expect(staging).toBe(prod);
    expect(prod).toContain('starts_with(http.host, "host-")');
    expect(prod).toContain('ends_with(http.host, ".cocalc.ai")');
    expect(prod).not.toContain("cocalc-prod");
    expect(prod).not.toContain("cocalc-staging");
  });

  it("adds the v2 Full SSL rule without replacing legacy or unrelated rules", async () => {
    const rules: any[] = [
      {
        id: "unrelated-rule",
        ref: "unrelated",
        description: "unrelated configuration",
      },
      {
        id: "legacy-project-host-rule",
        ref: "cocalc_project_host_direct_tls",
        description:
          "CoCalc project-host direct ingress uses encrypted Cloudflare origin traffic",
        expression:
          '(starts_with(http.host, "host-") and ends_with(http.host, "-cocalc-staging.cocalc.ai"))',
        action: "set_config",
        action_parameters: { ssl: "full" },
        enabled: true,
      },
    ];
    fetchMock.mockImplementation(async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/zones?")) return zoneResponse;
      if (url.endsWith("/zones/zone-1/rulesets")) {
        if (init?.method === "POST") {
          throw new Error("existing ruleset must not be replaced");
        }
        return responseWith([
          {
            id: "config-ruleset",
            kind: "zone",
            phase: "http_config_settings",
          },
        ]);
      }
      if (
        url.endsWith("/rulesets/config-ruleset/rules") &&
        init?.method === "POST"
      ) {
        const rule = JSON.parse(init.body as string);
        rules.push({ ...rule, id: "project-host-rule" });
        return responseWith(rules.at(-1));
      }
      if (url.endsWith("/rulesets/config-ruleset")) {
        return responseWith({
          id: "config-ruleset",
          kind: "zone",
          phase: "http_config_settings",
          rules,
        });
      }
      return responseWith({});
    });
    (global as any).fetch = fetchMock;

    const { ensureCloudflareProjectHostSslRule } = await import("./dns");
    const result = await ensureCloudflareProjectHostSslRule({
      hostname: "host-abc123-dev.example.com",
      host_id: "abc123",
    });

    expect(result).toMatchObject({
      ruleset_id: "config-ruleset",
      rule_id: "project-host-rule",
      ref: "cocalc_project_host_direct_tls_v2",
      ssl: "full",
    });
    expect(result.expression).toContain('starts_with(http.host, "host-")');
    expect(result.expression).toContain('ends_with(http.host, ".example.com")');
    expect(result.expression).toContain(
      'starts_with(http.host, "direct-check-")',
    );
    expect(rules[0]?.id).toBe("unrelated-rule");
    expect(rules[1]?.id).toBe("legacy-project-host-rule");
    expect(rules[1]?.expression).toContain("cocalc-staging.cocalc.ai");
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH"),
    ).toBe(false);
    const createCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith("/rulesets/config-ruleset/rules") &&
        init?.method === "POST",
    );
    expect(JSON.parse(createCall?.[1]?.body as string)).toMatchObject({
      action: "set_config",
      action_parameters: { ssl: "full" },
      enabled: true,
    });
  });

  it("updates a stale v2 SSL rule in place and verifies its contents", async () => {
    let managedRule: any = {
      id: "project-host-rule",
      ref: "cocalc_project_host_direct_tls_v2",
      description:
        "CoCalc project-host direct ingress uses zone-wide encrypted origin traffic",
      expression: "stale expression",
      action: "set_config",
      action_parameters: { ssl: "flexible" },
      enabled: true,
    };
    fetchMock.mockImplementation(async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/zones?")) return zoneResponse;
      if (url.endsWith("/zones/zone-1/rulesets")) {
        return responseWith([
          {
            id: "config-ruleset",
            kind: "zone",
            phase: "http_config_settings",
          },
        ]);
      }
      if (
        url.endsWith("/rulesets/config-ruleset/rules/project-host-rule") &&
        init?.method === "PATCH"
      ) {
        managedRule = {
          ...JSON.parse(init.body as string),
          id: "project-host-rule",
        };
        return responseWith(managedRule);
      }
      if (url.endsWith("/rulesets/config-ruleset")) {
        return responseWith({ id: "config-ruleset", rules: [managedRule] });
      }
      return responseWith({});
    });
    (global as any).fetch = fetchMock;

    const { ensureCloudflareProjectHostSslRule } = await import("./dns");
    await ensureCloudflareProjectHostSslRule({
      hostname: "host-abc123-dev.example.com",
      host_id: "abc123",
    });

    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith(
            "/rulesets/config-ruleset/rules/project-host-rule",
          ) && init?.method === "PATCH",
      ),
    ).toBe(true);
  });

  it("does not rewrite an exact v2 SSL rule", async () => {
    const expression =
      '((starts_with(http.host, "host-") and ends_with(http.host, ".example.com")) or (starts_with(http.host, "direct-check-") and ends_with(http.host, ".example.com")))';
    const managedRule = {
      id: "project-host-rule",
      ref: "cocalc_project_host_direct_tls_v2",
      description:
        "CoCalc project-host direct ingress uses zone-wide encrypted origin traffic",
      expression,
      action: "set_config",
      action_parameters: { ssl: "full" },
      enabled: true,
    };
    fetchMock.mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("/zones?")) return zoneResponse;
      if (url.endsWith("/zones/zone-1/rulesets")) {
        return responseWith([
          {
            id: "config-ruleset",
            kind: "zone",
            phase: "http_config_settings",
          },
        ]);
      }
      if (url.endsWith("/rulesets/config-ruleset")) {
        return responseWith({ id: "config-ruleset", rules: [managedRule] });
      }
      return responseWith({});
    });
    (global as any).fetch = fetchMock;

    const { ensureCloudflareProjectHostSslRule } = await import("./dns");
    await ensureCloudflareProjectHostSslRule({
      hostname: "host-abc123-dev.example.com",
      host_id: "abc123",
    });

    expect(
      fetchMock.mock.calls.some(([, init]) =>
        ["POST", "PATCH"].includes(`${init?.method}`),
      ),
    ).toBe(false);
  });

  it("updates an existing record when record_id is provided", async () => {
    const { ensureHostDns } = await import("./dns");
    await ensureHostDns({
      host_id: "abc",
      ipAddress: "203.0.113.6",
      record_id: "record-xyz",
    });
    const editCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes("/dns_records/record-xyz") &&
        init?.method === "PUT",
    );
    const payload = editCall?.[1]?.body
      ? JSON.parse(editCall[1].body)
      : undefined;
    expect(payload.content).toBe("203.0.113.6");
    expect(payload.proxied).toBe(true);
  });

  it("atomically converts an existing tunnel CNAME into an A record", async () => {
    fetchMock.mockImplementation(async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/zones?")) {
        return zoneResponse;
      }
      if (init?.method === "GET" && url.includes("/dns_records?")) {
        return responseWith([
          {
            id: "tunnel-record",
            name: "host-abc-dev.example.com",
            type: "CNAME",
            content: "tunnel.cfargotunnel.com",
          },
        ]);
      }
      if (
        init?.method === "PUT" &&
        url.includes("/dns_records/tunnel-record")
      ) {
        return responseWith({ id: "tunnel-record" });
      }
      return responseWith({});
    });

    const { ensureHostDns } = await import("./dns");
    const result = await ensureHostDns({
      host_id: "abc",
      ipAddress: "203.0.113.9",
    });

    expect(result.record_id).toBe("tunnel-record");
    const updateCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes("/dns_records/tunnel-record") &&
        init?.method === "PUT",
    );
    expect(JSON.parse(updateCall?.[1]?.body as string)).toMatchObject({
      type: "A",
      content: "203.0.113.9",
      proxied: true,
    });
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "POST"),
    ).toBe(false);
  });

  it("loads Cloudflare IPv4 edge ranges", async () => {
    fetchMock.mockResolvedValueOnce(
      responseWith({
        ipv4_cidrs: ["173.245.48.0/20", "103.21.244.0/22"],
      }),
    );

    const { getCloudflareIpv4Cidrs } = await import("./dns");
    await expect(getCloudflareIpv4Cidrs()).resolves.toEqual([
      "103.21.244.0/22",
      "173.245.48.0/20",
    ]);
  });

  it("dedupes existing A records for the same name", async () => {
    fetchMock.mockImplementation(async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/zones?")) {
        return zoneResponse;
      }
      if (init?.method === "GET" && url.includes("/dns_records?")) {
        return responseWith([
          {
            id: "record-a",
            name: "host-abc-dev.example.com",
            type: "A",
          },
          {
            id: "record-b",
            name: "host-abc-dev.example.com",
            type: "A",
          },
        ]);
      }
      if (init?.method === "PUT" && url.includes("/dns_records/record-a")) {
        return responseWith({ id: "record-a" });
      }
      if (init?.method === "DELETE" && url.includes("/dns_records/record-b")) {
        return responseWith({ id: "record-b" });
      }
      return responseWith({});
    });
    const { ensureHostDns } = await import("./dns");
    await ensureHostDns({ host_id: "abc", ipAddress: "203.0.113.7" });
    const deleteCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes("/dns_records/record-b") &&
        init?.method === "DELETE",
    );
    expect(deleteCall).toBeTruthy();
  });

  it("ignores deletion when record is not found", async () => {
    fetchMock.mockImplementation(async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/zones?")) {
        return zoneResponse;
      }
      if (init?.method === "GET" && url.includes("/dns_records?")) {
        return responseWith([]);
      }
      if (init?.method === "DELETE" && url.includes("/dns_records/record-1")) {
        return {
          ok: false,
          status: 404,
          statusText: "Not Found",
          json: async () => ({}),
        };
      }
      return responseWith({});
    });
    const { deleteHostDns } = await import("./dns");
    await expect(deleteHostDns({ record_id: "record-1" })).resolves.toBe(
      undefined,
    );
  });

  it("ensures a proxied cname for the public viewer domain", async () => {
    mockedSettings = {
      project_hosts_cloudflare_tunnel_api_token: "token",
      dns: "https://dev.example.com",
      public_viewer_dns: "",
    };

    const { ensurePublicViewerDns } = await import("./dns");
    const result = await ensurePublicViewerDns();

    expect(result).toEqual({
      hostname: "dev-raw.example.com",
      target_hostname: "dev.example.com",
      record_id: "record-1",
    });

    const addCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes("/dns_records") && init?.method === "POST",
    );
    const record = addCall?.[1]?.body ? JSON.parse(addCall[1].body) : undefined;
    expect(record.type).toBe("CNAME");
    expect(record.name).toBe("dev-raw.example.com");
    expect(record.content).toBe("dev.example.com");
    expect(record.proxied).toBe(true);
  });

  it("preserves non-address records when replacing a hostname with an app cname", async () => {
    fetchMock.mockImplementation(async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/zones?")) {
        return zoneResponse;
      }
      if (init?.method === "GET" && url.includes("/dns_records?")) {
        if (url.includes("type=CNAME")) {
          return responseWith([]);
        }
        return responseWith([
          { id: "record-a", name: "demo-app.example.com", type: "A" },
          { id: "record-aaaa", name: "demo-app.example.com", type: "AAAA" },
          { id: "record-txt", name: "demo-app.example.com", type: "TXT" },
          { id: "record-caa", name: "demo-app.example.com", type: "CAA" },
        ]);
      }
      if (init?.method === "DELETE") {
        return responseWith({});
      }
      if (init?.method === "POST" && url.includes("/dns_records")) {
        return responseWith({ id: "record-cname" });
      }
      if (init?.method === "PUT" && url.includes("/dns_records/record-cname")) {
        return responseWith({ id: "record-cname" });
      }
      return responseWith({});
    });

    const { ensureAppSubdomainDns } = await import("./dns");
    await ensureAppSubdomainDns({
      hostname: "demo-app.example.com",
      target_hostname: "host-abc.example.com",
    });

    const deletedIds = fetchMock.mock.calls
      .filter(([, init]) => init?.method === "DELETE")
      .map(([url]) => String(url).split("/dns_records/")[1]);
    expect(deletedIds).toContain("record-a");
    expect(deletedIds).toContain("record-aaaa");
    expect(deletedIds).not.toContain("record-txt");
    expect(deletedIds).not.toContain("record-caa");
  });

  it("recreates an app cname when the stored record id is stale", async () => {
    fetchMock.mockImplementation(async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/zones?")) {
        return zoneResponse;
      }
      if (init?.method === "GET" && url.includes("/dns_records?")) {
        return responseWith([]);
      }
      if (
        init?.method === "PUT" &&
        url.includes("/dns_records/stale-record-id")
      ) {
        return {
          ok: true,
          json: async () => ({
            success: false,
            errors: [{ message: "Record does not exist." }],
          }),
        };
      }
      if (init?.method === "POST" && url.includes("/dns_records")) {
        return responseWith({ id: "record-fresh" });
      }
      return responseWith({});
    });

    const { ensureAppSubdomainDns } = await import("./dns");
    const result = await ensureAppSubdomainDns({
      hostname: "demo-app.example.com",
      target_hostname: "host-abc.example.com",
      record_id: "stale-record-id",
    });

    expect(result.record_id).toBe("record-fresh");
    const createCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes("/dns_records") && init?.method === "POST",
    );
    const record = createCall?.[1]?.body
      ? JSON.parse(createCall[1].body)
      : undefined;
    expect(record.type).toBe("CNAME");
    expect(record.name).toBe("demo-app.example.com");
    expect(record.content).toBe("host-abc.example.com");
  });

  it("points the public viewer hostname directly at the tunnel target", async () => {
    mockedSettings = {
      project_hosts_cloudflare_tunnel_api_token: "token",
      dns: "https://dev.example.com",
      public_viewer_dns: "dev-raw.example.com",
    };

    fetchMock.mockImplementation(async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/zones?")) {
        return responseWith([{ name: "example.com", id: "zone-1" }]);
      }
      if (init?.method === "GET" && url.includes("/dns_records?")) {
        if (url.includes("name=dev.example.com")) {
          return responseWith([
            {
              id: "record-site",
              name: "dev.example.com",
              type: "CNAME",
              content: "62a1de15-deb4-448f-a5d8-480debc959fb.cfargotunnel.com",
            },
          ]);
        }
        if (url.includes("name=dev-raw.example.com")) {
          return responseWith([]);
        }
      }
      if (init?.method === "POST" && url.includes("/dns_records")) {
        return responseWith({ id: "record-raw" });
      }
      return responseWith({});
    });
    (global as any).fetch = fetchMock;

    const { ensurePublicViewerDns } = await import("./dns");
    const result = await ensurePublicViewerDns();

    expect(result).toEqual({
      hostname: "dev-raw.example.com",
      target_hostname: "62a1de15-deb4-448f-a5d8-480debc959fb.cfargotunnel.com",
      record_id: "record-raw",
    });

    const addCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes("/dns_records") && init?.method === "POST",
    );
    const record = addCall?.[1]?.body ? JSON.parse(addCall[1].body) : undefined;
    expect(record.content).toBe(
      "62a1de15-deb4-448f-a5d8-480debc959fb.cfargotunnel.com",
    );
  });

  it("allows a sibling raw hostname under the parent cloudflare zone", async () => {
    mockedSettings = {
      project_hosts_cloudflare_tunnel_api_token: "token",
      dns: "https://dev.example.com",
      public_viewer_dns: "dev-raw.example.com",
    };

    fetchMock.mockImplementation(async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/zones?")) {
        if (
          url.includes("name=dev.example.com") ||
          url.includes("name=dev-raw.example.com")
        ) {
          return responseWith([]);
        }
        if (url.includes("name=example.com")) {
          return responseWith([{ name: "example.com", id: "zone-parent" }]);
        }
      }
      if (init?.method === "GET" && url.includes("/dns_records?")) {
        return responseWith([]);
      }
      if (init?.method === "POST" && url.includes("/dns_records")) {
        return responseWith({ id: "record-sibling" });
      }
      return responseWith({});
    });
    (global as any).fetch = fetchMock;

    const { ensurePublicViewerDns } = await import("./dns");
    const result = await ensurePublicViewerDns();

    expect(result).toEqual({
      hostname: "dev-raw.example.com",
      target_hostname: "dev.example.com",
      record_id: "record-sibling",
    });
  });
});
