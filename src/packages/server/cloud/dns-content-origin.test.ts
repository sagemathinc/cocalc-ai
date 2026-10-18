/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// DNS for per-project content origins (trust-free step 6): one proxied
// wildcard record per project host, created with the host's own record and
// removed before it, so a released address never keeps serving them.

jest.mock(
  "@cocalc/util/project-content-origin",
  () => jest.requireActual("../../util/project-content-origin"),
  { virtual: true },
);

let mockedSettings: Record<string, any>;
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: jest.fn(async () => mockedSettings),
}));

const HOST_ID = "11111111-2222-4333-8444-555555555555";
const HOST_NAME = `host-${HOST_ID}-dev.example.com`;
const WILDCARD = "*.h-11111111222243338444555555555555.usercontent.example.com";

type Rec = { id: string; type: string; name: string; content: string; proxied: boolean };

let records: Rec[];
let calls: string[];
let failWildcardWrites: boolean;
let failWildcardDeletes: boolean;
let zones: string[];
let nextId: number;

function ok(result: any) {
  return { ok: true, json: async () => ({ success: true, result }) };
}
function fail(message: string) {
  return {
    ok: true,
    json: async () => ({ success: false, errors: [{ message }] }),
  };
}

beforeEach(() => {
  jest.resetModules();
  mockedSettings = {
    project_hosts_cloudflare_tunnel_api_token: "token",
    dns: "dev.example.com",
    project_content_dns: "usercontent.example.com",
  };
  records = [];
  calls = [];
  failWildcardWrites = false;
  failWildcardDeletes = false;
  zones = ["example.com"];
  nextId = 1;
  (global as any).fetch = jest.fn(async (input: any, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.pathname.endsWith("/zones")) {
      const name = url.searchParams.get("name");
      // a wildcard is a record name, never a zone name
      if (`${name}`.startsWith("*")) {
        return { ok: false, status: 400, statusText: "Bad Request", json: async () => ({}) };
      }
      return ok(zones.includes(`${name}`) ? [{ name, id: `zone-${name}` }] : []);
    }
    const idMatch = url.pathname.match(/\/dns_records\/([^/]+)$/);
    if (method === "GET" && url.pathname.endsWith("/dns_records")) {
      const name = url.searchParams.get("name");
      const type = url.searchParams.get("type");
      return ok(
        records.filter((r) => (!name || r.name === name) && (!type || r.type === type)),
      );
    }
    if (method === "GET" && idMatch) {
      const rec = records.find((r) => r.id === idMatch[1]);
      return rec ? ok(rec) : fail("record not found");
    }
    if (method === "POST" && url.pathname.endsWith("/dns_records")) {
      const body = JSON.parse(`${init?.body}`);
      if (failWildcardWrites && body.name.startsWith("*.")) return fail("forbidden");
      const rec = { ...body, id: `rec-${nextId++}` };
      records.push(rec);
      calls.push(`POST ${body.name}`);
      return ok(rec);
    }
    if (method === "PUT" && idMatch) {
      const body = JSON.parse(`${init?.body}`);
      records = records.map((r) => (r.id === idMatch[1] ? { ...body, id: r.id } : r));
      calls.push(`PUT ${body.name}`);
      return ok({ ...body, id: idMatch[1] });
    }
    if (method === "DELETE" && idMatch) {
      const rec = records.find((r) => r.id === idMatch[1]);
      if (failWildcardDeletes && rec?.name.startsWith("*.")) return fail("forbidden");
      records = records.filter((r) => r.id !== idMatch[1]);
      calls.push(`DELETE ${rec?.name ?? idMatch[1]}`);
      return ok({ id: idMatch[1] });
    }
    return ok({});
  });
});

describe("project content origin DNS", () => {
  it("creates the host's proxied wildcard next to its own record", async () => {
    const { ensureHostDns } = await import("./dns");
    const dns = await ensureHostDns({ host_id: HOST_ID, ipAddress: "203.0.113.7" });
    expect(dns.name).toBe(HOST_NAME);
    expect(records.map(({ name, type, content, proxied }) => ({ name, type, content, proxied }))).toEqual([
      { name: HOST_NAME, type: "A", content: "203.0.113.7", proxied: true },
      { name: WILDCARD, type: "A", content: "203.0.113.7", proxied: true },
    ]);
  });

  it("follows a new address and creates nothing without a content domain", async () => {
    const { ensureHostDns } = await import("./dns");
    await ensureHostDns({ host_id: HOST_ID, ipAddress: "203.0.113.7" });
    await ensureHostDns({ host_id: HOST_ID, ipAddress: "198.51.100.9" });
    expect(records.filter((r) => r.name === WILDCARD).map((r) => r.content)).toEqual([
      "198.51.100.9",
    ]);
    records = [];
    mockedSettings.project_content_dns = "";
    await ensureHostDns({ host_id: HOST_ID, ipAddress: "203.0.113.7" });
    expect(records.map((r) => r.name)).toEqual([HOST_NAME]);
  });

  it("still provisions the host when its content record fails", async () => {
    failWildcardWrites = true;
    const { ensureHostDns } = await import("./dns");
    await expect(
      ensureHostDns({ host_id: HOST_ID, ipAddress: "203.0.113.7" }),
    ).resolves.toMatchObject({ name: HOST_NAME });
    expect(records.map((r) => r.name)).toEqual([HOST_NAME]);
  });

  it("removes every content record before the host's own record", async () => {
    const { ensureHostDns, deleteHostDns } = await import("./dns");
    const dns = await ensureHostDns({ host_id: HOST_ID, ipAddress: "203.0.113.7" });
    // a stale duplicate whose id was never saved
    records.push({ id: "stale", type: "A", name: WILDCARD, content: "192.0.2.1", proxied: true });
    calls = [];
    await deleteHostDns({ record_id: dns.record_id, name: dns.name });
    expect(records).toEqual([]);
    expect(calls).toEqual([`DELETE ${WILDCARD}`, `DELETE ${WILDCARD}`, `DELETE ${HOST_NAME}`]);
  });

  it("keeps the host record, and fails, when a content record cannot be removed", async () => {
    const { ensureHostDns, deleteHostDns } = await import("./dns");
    const dns = await ensureHostDns({ host_id: HOST_ID, ipAddress: "203.0.113.7" });
    failWildcardDeletes = true;
    await expect(deleteHostDns({ record_id: dns.record_id, name: dns.name })).rejects.toThrow();
    expect(records.map((r) => r.name).sort()).toEqual([WILDCARD, HOST_NAME].sort());
  });

  it("proceeds when the account has no zone for the content domain", async () => {
    const { ensureHostDns, deleteHostDns } = await import("./dns");
    const dns = await ensureHostDns({ host_id: HOST_ID, ipAddress: "203.0.113.7" });
    records = records.filter((r) => r.name !== WILDCARD);
    mockedSettings.project_content_dns = "cocalcusercontent.test";
    await deleteHostDns({ record_id: dns.record_id, name: dns.name });
    expect(records).toEqual([]);
  });

  it("leaves non-host records alone", async () => {
    const { deleteHostDns, projectHostIdFromHostname } = await import("./dns");
    expect(projectHostIdFromHostname(HOST_NAME)).toBe(HOST_ID);
    expect(projectHostIdFromHostname("direct-check-abc.example.com")).toBeUndefined();
    expect(projectHostIdFromHostname(`xhost-${HOST_ID}.example.com`)).toBeUndefined();
    records.push({ id: "w", type: "A", name: WILDCARD, content: "203.0.113.7", proxied: true });
    records.push({ id: "p", type: "A", name: "direct-check-abc.example.com", content: "203.0.113.7", proxied: true });
    await deleteHostDns({ record_id: "p", name: "direct-check-abc.example.com" });
    expect(records.map((r) => r.id)).toEqual(["w"]);
  });
});
