let fetchMock: jest.Mock;
let mockedSettings: {
  project_hosts_dns: string;
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
      project_hosts_dns: "example.com",
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
      project_hosts_dns: "dev.example.com",
      project_hosts_cloudflare_tunnel_api_token: "token",
    };
    fetchMock = jest.fn(async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/zones?")) {
        if (url.includes("name=dev.example.com")) {
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

    expect(result.name).toBe("host-abc.dev.example.com");
    expect(result.record_id).toBe("record-parent");
    const zoneCalls = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes("/zones?"));
    expect(zoneCalls.some((url) => url.includes("name=dev.example.com"))).toBe(
      true,
    );
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
    expect(result.name).toBe("host-abc.example.com");
    expect(result.record_id).toBe("record-1");

    const addCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes("/dns_records") && init?.method === "POST",
    );
    const record = addCall?.[1]?.body ? JSON.parse(addCall[1].body) : undefined;
    expect(record.type).toBe("A");
    expect(record.content).toBe("203.0.113.5");
    expect(record.name).toBe("host-abc.example.com");
    expect(record.proxied).toBe(true);
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

  it("dedupes existing A records for the same name", async () => {
    fetchMock.mockImplementation(async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/zones?")) {
        return zoneResponse;
      }
      if (init?.method === "GET" && url.includes("/dns_records?")) {
        return responseWith([
          { id: "record-a", name: "host-abc.example.com" },
          { id: "record-b", name: "host-abc.example.com" },
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
      project_hosts_dns: "example.com",
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

  it("allows a sibling raw hostname under the parent cloudflare zone", async () => {
    mockedSettings = {
      project_hosts_dns: "dev.example.com",
      project_hosts_cloudflare_tunnel_api_token: "token",
      dns: "https://dev.example.com",
      public_viewer_dns: "dev-raw.example.com",
    };

    fetchMock.mockImplementation(async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/zones?")) {
        if (url.includes("name=dev.example.com")) {
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
