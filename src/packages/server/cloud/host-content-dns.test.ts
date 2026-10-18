/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Content-origin DNS (trust-free step 6): one proxied wildcard per project
// host, recorded in metadata.content_dns, removed (from that record) before
// the host's address can be released, and swept when its host is gone.

jest.mock(
  "@cocalc/util/project-content-origin",
  () => jest.requireActual("../../util/project-content-origin"),
  { virtual: true },
);

let mockedSettings: Record<string, any>;
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: jest.fn(async () => mockedSettings),
}));

type HostRow = {
  id: string;
  status: string;
  deleted: string | null;
  bay_id: string | null;
  metadata: Record<string, any>;
};
let hosts: Map<string, HostRow>;
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({
    query: async (sql: string, params: any[] = []) => {
      const q = sql.replace(/\s+/g, " ");
      if (q.includes("- 'content_dns'")) {
        const h = hosts.get(params[0]);
        if (h) delete h.metadata.content_dns;
        return { rows: [], rowCount: h ? 1 : 0 };
      }
      if (q.includes("'{content_dns}'")) {
        const h = hosts.get(params[0]);
        if (h && h.deleted == null) h.metadata.content_dns = JSON.parse(params[1]);
        return { rows: [], rowCount: h ? 1 : 0 };
      }
      if (q.includes("SELECT DISTINCT metadata->'content_dns'->>'domain'")) {
        const domains = new Set(
          [...hosts.values()]
            .map((h) => h.metadata.content_dns?.domain)
            .filter(Boolean),
        );
        return { rows: [...domains].map((domain) => ({ domain })) };
      }
      if (q.includes("FROM project_hosts WHERE id = $1")) {
        const h = hosts.get(params[0]);
        return {
          rows: h
            ? [
                {
                  status: h.status,
                  deleted: h.deleted,
                  bay_id: h.bay_id ?? params[1],
                  ip: h.metadata.runtime?.public_ip ?? null,
                },
              ]
            : [],
        };
      }
      throw new Error(`unexpected query: ${q}`);
    },
  }),
}));

jest.mock("../bay-config", () => ({ getConfiguredBayId: () => "bay-local" }));

const HOST = "11111111-2222-4333-8444-555555555555";
const HOST_HEX = "11111111222243338444555555555555";
const WILDCARD = `*.h-${HOST_HEX}.usercontent.example.org`;

type Rec = { id: string; type: string; name: string; content: string; proxied: boolean };
let zones: Record<string, Rec[]>;
let calls: string[];
let authHeaders: string[];
let failDeletesFor: Set<string>;
let nextId: number;

function ok(result: any) {
  return { ok: true, json: async () => ({ success: true, result }) };
}
function fail(message: string) {
  return { ok: true, json: async () => ({ success: false, errors: [{ message }] }) };
}

beforeEach(() => {
  jest.resetModules();
  mockedSettings = {
    dns: "cocalc.example.com",
    project_hosts_cloudflare_tunnel_api_token: "tunnel-token",
    project_content_cloudflare_api_token: "content-token",
    project_content_dns: "usercontent.example.org",
  };
  hosts = new Map([
    [
      HOST,
      {
        id: HOST,
        status: "running",
        deleted: null,
        bay_id: null,
        metadata: { runtime: { public_ip: "203.0.113.7" } },
      },
    ],
  ]);
  zones = { "usercontent.example.org": [], "old.example.net": [] };
  calls = [];
  authHeaders = [];
  failDeletesFor = new Set();
  nextId = 1;
  (global as any).fetch = jest.fn(async (input: any, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    authHeaders.push(`${(init?.headers as any)?.Authorization ?? ""}`);
    if (url.pathname.endsWith("/zones")) {
      const name = `${url.searchParams.get("name")}`;
      if (name.startsWith("*")) {
        return { ok: false, status: 400, statusText: "Bad Request", json: async () => ({}) };
      }
      return ok(name in zones ? [{ name, id: `zone:${name}` }] : []);
    }
    const zoneMatch = url.pathname.match(/\/zones\/zone:([^/]+)\/dns_records(?:\/([^/]+))?$/);
    if (!zoneMatch) return ok({});
    const records = zones[zoneMatch[1]];
    const id = zoneMatch[2];
    if (method === "GET" && !id) {
      const name = url.searchParams.get("name");
      const type = url.searchParams.get("type");
      const endswith = url.searchParams.get("name.endswith");
      return ok(
        records.filter(
          (r) =>
            (!name || r.name === name) &&
            (!type || r.type === type) &&
            (!endswith || r.name.endsWith(endswith)),
        ),
      );
    }
    if (method === "GET" && id) {
      const rec = records.find((r) => r.id === id);
      return rec ? ok(rec) : fail("record not found");
    }
    if (method === "POST") {
      const body = JSON.parse(`${init?.body}`);
      const rec = { ...body, id: `rec-${nextId++}` };
      records.push(rec);
      calls.push(`POST ${body.name} ${body.content}`);
      return ok(rec);
    }
    if (method === "PUT" && id) {
      const body = JSON.parse(`${init?.body}`);
      const i = records.findIndex((r) => r.id === id);
      if (i >= 0) records[i] = { ...body, id };
      calls.push(`PUT ${body.name} ${body.content}`);
      return ok({ ...body, id });
    }
    if (method === "DELETE" && id) {
      const rec = records.find((r) => r.id === id);
      if (rec && failDeletesFor.has(rec.name)) return fail("forbidden");
      zones[zoneMatch[1]] = records.filter((r) => r.id !== id);
      calls.push(`DELETE ${rec?.name ?? id}`);
      return ok({ id });
    }
    return ok({});
  });
});

const row = () => hosts.get(HOST)!;
const load = async () => await import("./host-content-dns");

describe("resolveProjectContentDomain", () => {
  it("accepts a separate registrable domain and refuses the site's own", async () => {
    const { resolveProjectContentDomain } = await load();
    expect(resolveProjectContentDomain({ dns: "cocalc.ai", project_content_dns: "cocalcusercontent.com" })).toBe(
      "cocalcusercontent.com",
    );
    for (const project_content_dns of ["cocalc.ai", "content.cocalc.ai", "ai"]) {
      expect(resolveProjectContentDomain({ dns: "cocalc.ai", project_content_dns })).toBeUndefined();
    }
    // a subdomain site shares cookies with its registrable domain
    expect(
      resolveProjectContentDomain({ dns: "lite4b.cocalc.ai", project_content_dns: "usercontent.cocalc.ai" }),
    ).toBeUndefined();
    expect(resolveProjectContentDomain({ dns: "cocalc.ai", project_content_dns: "" })).toBeUndefined();
  });
});

describe("syncHostContentDns", () => {
  it("points the host's wildcard at its address and records it, with the content token", async () => {
    const { syncHostContentDns } = await load();
    await syncHostContentDns(row());
    expect(zones["usercontent.example.org"].map((r) => [r.name, r.type, r.content, r.proxied])).toEqual([
      [WILDCARD, "A", "203.0.113.7", true],
    ]);
    expect(row().metadata.content_dns).toMatchObject({
      name: WILDCARD,
      domain: "usercontent.example.org",
      ip: "203.0.113.7",
    });
    expect(authHeaders.every((h) => h === "Bearer content-token")).toBe(true);
  });

  it("falls back to the tunnel token when no content token is set", async () => {
    mockedSettings.project_content_cloudflare_api_token = "";
    const { syncHostContentDns } = await load();
    await syncHostContentDns(row());
    expect(authHeaders.length).toBeGreaterThan(0);
    expect(authHeaders.every((h) => h === "Bearer tunnel-token")).toBe(true);
  });

  it("moves the record to a new domain, deleting the old one first", async () => {
    const { syncHostContentDns } = await load();
    await syncHostContentDns(row());
    zones["old.example.net"] = [];
    mockedSettings.project_content_dns = "old.example.net";
    calls = [];
    await syncHostContentDns(row());
    expect(calls[0]).toBe(`DELETE ${WILDCARD}`);
    expect(zones["usercontent.example.org"]).toEqual([]);
    expect(zones["old.example.net"].map((r) => r.name)).toEqual([`*.h-${HOST_HEX}.old.example.net`]);
    expect(row().metadata.content_dns.domain).toBe("old.example.net");
  });

  it("removes the recorded wildcard when the setting is cleared", async () => {
    const { syncHostContentDns } = await load();
    await syncHostContentDns(row());
    mockedSettings.project_content_dns = "";
    await syncHostContentDns(row());
    expect(zones["usercontent.example.org"]).toEqual([]);
    expect(row().metadata.content_dns).toBeUndefined();
  });

  it("never throws", async () => {
    zones = {};
    const { syncHostContentDns } = await load();
    await expect(syncHostContentDns(row())).resolves.toBeUndefined();
    expect(row().metadata.content_dns).toBeUndefined();
  });
});

describe("releaseHostContentDns", () => {
  it("deletes from the record even after the setting was cleared or changed", async () => {
    const { syncHostContentDns, releaseHostContentDns } = await load();
    await syncHostContentDns(row());
    // a stale duplicate whose id was never saved
    zones["usercontent.example.org"].push({ id: "stale", type: "A", name: WILDCARD, content: "192.0.2.1", proxied: true });
    mockedSettings.project_content_dns = "";
    await releaseHostContentDns(row());
    expect(zones["usercontent.example.org"]).toEqual([]);
    expect(row().metadata.content_dns).toBeUndefined();
  });

  it("throws, keeping the record, when a wildcard cannot be removed", async () => {
    const { syncHostContentDns, releaseHostContentDns } = await load();
    await syncHostContentDns(row());
    failDeletesFor.add(WILDCARD);
    await expect(releaseHostContentDns(row())).rejects.toThrow();
    expect(row().metadata.content_dns?.name).toBe(WILDCARD);
  });

  it("treats a missing zone as nothing to remove only if nothing was recorded", async () => {
    const { releaseHostContentDns } = await load();
    zones = {};
    await expect(releaseHostContentDns(row())).resolves.toBeUndefined();
    row().metadata.content_dns = {
      name: WILDCARD,
      record_id: "rec-x",
      domain: "usercontent.example.org",
      ip: "203.0.113.7",
    };
    await expect(releaseHostContentDns(row())).rejects.toThrow("zone not found");
    expect(row().metadata.content_dns).toBeDefined();
  });

  it("refuses to forget a recorded wildcard without a token", async () => {
    const { syncHostContentDns, releaseHostContentDns } = await load();
    await syncHostContentDns(row());
    mockedSettings.project_content_cloudflare_api_token = "";
    mockedSettings.project_hosts_cloudflare_tunnel_api_token = "";
    await expect(releaseHostContentDns(row())).rejects.toThrow("no Cloudflare API token");
    expect(row().metadata.content_dns).toBeDefined();
  });
});

describe("sweepProjectContentDns", () => {
  const add = (zone: string, hex: string, content: string) =>
    zones[zone].push({ id: `r-${hex}-${zone}`, type: "A", name: `*.h-${hex}.${zone}`, content, proxied: true });
  const hexOf = (id: string) => id.replace(/-/g, "");

  it("keeps live hosts' records and deletes stale ones", async () => {
    const off = "21111111-2222-4333-8444-555555555555";
    const moved = "31111111-2222-4333-8444-555555555555";
    const gone = "41111111-2222-4333-8444-555555555555";
    const unknown = "51111111-2222-4333-8444-555555555555";
    const otherBay = "61111111-2222-4333-8444-555555555555";
    const remote = "71111111-2222-4333-8444-555555555555";
    const lookupFails = "81111111-2222-4333-8444-555555555555";
    hosts.set(off, { id: off, status: "off", deleted: null, bay_id: null, metadata: { runtime: { public_ip: "198.51.100.2" } } });
    hosts.set(moved, { id: moved, status: "running", deleted: null, bay_id: null, metadata: { runtime: { public_ip: "198.51.100.30" } } });
    hosts.set(gone, { id: gone, status: "running", deleted: "2026-10-01", bay_id: null, metadata: { runtime: { public_ip: "198.51.100.4" } } });
    hosts.set(otherBay, { id: otherBay, status: "off", deleted: null, bay_id: "bay-2", metadata: {} });
    add("usercontent.example.org", HOST_HEX, "203.0.113.7"); // live: keep
    add("usercontent.example.org", hexOf(off), "198.51.100.2");
    add("usercontent.example.org", hexOf(moved), "198.51.100.3");
    add("usercontent.example.org", hexOf(gone), "198.51.100.4");
    add("usercontent.example.org", hexOf(unknown), "198.51.100.5");
    add("usercontent.example.org", hexOf(otherBay), "198.51.100.6"); // another bay's: keep
    add("usercontent.example.org", hexOf(remote), "198.51.100.7"); // another bay's: keep
    add("usercontent.example.org", hexOf(lookupFails), "198.51.100.8"); // unsure: keep
    zones["usercontent.example.org"].push({ id: "other", type: "A", name: "files.usercontent.example.org", content: "192.0.2.9", proxied: true });
    const { sweepProjectContentDns } = await load();
    const result = await sweepProjectContentDns({
      localBayId: "bay-local",
      resolveHostBay: async (id) => {
        if (id === remote) return { bay_id: "bay-2" };
        if (id === lookupFails) throw new Error("fabric down");
        return null;
      },
    });
    expect(zones["usercontent.example.org"].map((r) => r.name).sort()).toEqual(
      [
        WILDCARD,
        `*.h-${hexOf(otherBay)}.usercontent.example.org`,
        `*.h-${hexOf(remote)}.usercontent.example.org`,
        `*.h-${hexOf(lookupFails)}.usercontent.example.org`,
        "files.usercontent.example.org",
      ].sort(),
    );
    expect(result.deleted).toBe(4);
  });

  it("sweeps a domain that is only still recorded on a host", async () => {
    mockedSettings.project_content_dns = "";
    row().metadata.content_dns = { name: `*.h-${HOST_HEX}.old.example.net`, domain: "old.example.net" };
    add("old.example.net", HOST_HEX, "203.0.113.7");
    const { sweepProjectContentDns } = await load();
    await sweepProjectContentDns({ localBayId: "bay-local", resolveHostBay: async () => null });
    expect(zones["old.example.net"]).toEqual([]);
  });
});
