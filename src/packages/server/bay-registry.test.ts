let queryMock: jest.Mock;
let ensureHostnameCnameDnsMock: jest.Mock;
let deleteAppSubdomainDnsMock: jest.Mock;
let hasDnsMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

jest.mock("@cocalc/server/cloud/dns", () => ({
  __esModule: true,
  ensureHostnameCnameDns: (...args: any[]) =>
    ensureHostnameCnameDnsMock(...args),
  deleteAppSubdomainDns: (...args: any[]) => deleteAppSubdomainDnsMock(...args),
  hasDns: (...args: any[]) => hasDnsMock(...args),
}));

jest.mock("@cocalc/server/bay-public-origin", () => ({
  __esModule: true,
  deriveBayHostnameFromSiteDns: jest.fn(
    ({ bay_id, site_hostname }: { bay_id: string; site_hostname?: string }) =>
      site_hostname ? `${bay_id}-${site_hostname}` : undefined,
  ),
  getConfiguredSiteDnsHostname: jest.fn(async () => "lite4b.cocalc.ai"),
  getBayPublicOrigin: jest.fn(async (bay_id: string) => `https://${bay_id}`),
  getCurrentBayPublicTarget: jest.fn(() => undefined),
  normalizeHostname: jest.fn((value: unknown) => {
    const raw = `${value ?? ""}`.trim().toLowerCase();
    return raw || undefined;
  }),
}));

describe("bay-registry", () => {
  let rowsById: Map<string, any>;
  let now: Date;
  let prevRole: string | undefined;
  let prevBayId: string | undefined;

  beforeEach(() => {
    jest.resetModules();
    rowsById = new Map();
    now = new Date("2026-04-13T12:00:00.000Z");
    prevRole = process.env.COCALC_CLUSTER_ROLE;
    prevBayId = process.env.COCALC_BAY_ID;
    process.env.COCALC_CLUSTER_ROLE = "seed";
    process.env.COCALC_BAY_ID = "bay-0";

    ensureHostnameCnameDnsMock = jest.fn(async () => ({
      record_id: "dns-record-1",
    }));
    deleteAppSubdomainDnsMock = jest.fn(async () => undefined);
    hasDnsMock = jest.fn(async () => true);

    queryMock = jest.fn(async (sql: string, params?: any[]) => {
      if (
        sql.includes("CREATE TABLE IF NOT EXISTS cluster_bay_registry") ||
        sql.includes(
          "CREATE INDEX IF NOT EXISTS cluster_bay_registry_last_seen",
        )
      ) {
        return { rows: [] };
      }
      if (
        sql.includes("FROM cluster_bay_registry") &&
        sql.includes("WHERE bay_id=$1")
      ) {
        const row = rowsById.get(params?.[0]);
        return { rows: row ? [row] : [] };
      }
      if (
        sql.includes("FROM cluster_bay_registry") &&
        sql.includes("ORDER BY bay_id ASC")
      ) {
        return { rows: [...rowsById.values()] };
      }
      if (sql.includes("INSERT INTO cluster_bay_registry")) {
        rowsById.set(params?.[0], {
          bay_id: params?.[0],
          label: params?.[1],
          region: params?.[2],
          role: params?.[3],
          public_origin: params?.[4],
          public_target: params?.[5],
          public_target_kind: params?.[6],
          dns_hostname: params?.[7],
          dns_record_id: params?.[8],
          last_seen: now,
        });
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
  });

  afterEach(() => {
    if (prevRole == null) {
      delete process.env.COCALC_CLUSTER_ROLE;
    } else {
      process.env.COCALC_CLUSTER_ROLE = prevRole;
    }
    if (prevBayId == null) {
      delete process.env.COCALC_BAY_ID;
    } else {
      process.env.COCALC_BAY_ID = prevBayId;
    }
  });

  it("registers a bay heartbeat and reconciles derived dns on the seed", async () => {
    const { registerBayPresenceLocal } = await import("./bay-registry");

    const entry = await registerBayPresenceLocal({
      bay_id: "bay-2",
      label: "Sydney",
      region: "au",
      role: "attached",
      public_origin: "https://bay-2-lite4b.cocalc.ai",
      public_target: "abc123.cfargotunnel.com",
      public_target_kind: "hostname",
    });

    expect(ensureHostnameCnameDnsMock).toHaveBeenCalledWith({
      hostname: "bay-2-lite4b.cocalc.ai",
      target_hostname: "abc123.cfargotunnel.com",
      record_id: undefined,
    });
    expect(entry).toMatchObject({
      bay_id: "bay-2",
      label: "Sydney",
      region: "au",
      role: "attached",
      public_target: "abc123.cfargotunnel.com",
      dns_hostname: "bay-2-lite4b.cocalc.ai",
      dns_record_id: "dns-record-1",
    });
  });

  it("removes stale bay dns when no public target is advertised", async () => {
    rowsById.set("bay-2", {
      bay_id: "bay-2",
      label: "Sydney",
      region: "au",
      role: "attached",
      public_origin: "https://bay-2-lite4b.cocalc.ai",
      public_target: null,
      public_target_kind: null,
      dns_hostname: "bay-2-lite4b.cocalc.ai",
      dns_record_id: "old-record",
      last_seen: now,
    });

    const { registerBayPresenceLocal } = await import("./bay-registry");

    const entry = await registerBayPresenceLocal({
      bay_id: "bay-2",
      label: "Sydney",
      region: "au",
      role: "attached",
      public_origin: "https://bay-2-lite4b.cocalc.ai",
      public_target: null,
    });

    expect(deleteAppSubdomainDnsMock).toHaveBeenCalledWith({
      record_id: "old-record",
    });
    expect(entry.dns_record_id).toBeNull();
  });
});
