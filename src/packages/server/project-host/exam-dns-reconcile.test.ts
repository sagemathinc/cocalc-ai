/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let queryMock: jest.Mock;
let ensureProxiedAddressDnsMock: jest.Mock;
let ensureHostnameCnameDnsMock: jest.Mock;
let deleteHostDnsMock: jest.Mock;
const warn = jest.fn();

jest.mock("@cocalc/backend/data", () => ({
  conatPassword: "exam-test-secret",
}));

jest.mock("@cocalc/backend/logger", () => {
  const getLogger = () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn,
    error: jest.fn(),
  });
  return { __esModule: true, default: getLogger, getLogger };
});

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...args: any[]) => queryMock(...args) }),
}));

jest.mock("@cocalc/server/cloud/dns", () => ({
  ensureProxiedAddressDns: (...args: any[]) =>
    ensureProxiedAddressDnsMock(...args),
  ensureHostnameCnameDns: (...args: any[]) =>
    ensureHostnameCnameDnsMock(...args),
  deleteHostDns: (...args: any[]) => deleteHostDnsMock(...args),
}));

import { reconcileExamDnsOnce } from "./exam";

const ADDRESS_HOST = "00000000-1000-4000-8000-000000000001";
const TUNNEL_HOST = "00000000-1000-4000-8000-000000000002";
const DELETED_HOST = "00000000-1000-4000-8000-000000000003";

function configRow(host_id: string, extra: Record<string, unknown>) {
  return {
    host_id,
    enabled: true,
    hostname: `exam-${host_id}-cocalc-prod.cocalc.ai`,
    dns_record_id: `record-${host_id}`,
    generation: 1,
    max_projects: 10,
    project_cpu: 1,
    project_memory_mb: 2000,
    project_disk_mb: 5000,
    project_ttl_minutes: 60,
    cleanup_grace_minutes: 10,
    ...extra,
  };
}

describe("reconcileExamDnsOnce", () => {
  // On prod this failed every minute: the row had no host id (TypeError
  // reading host_id) and no public IP ("host must have a reconciled public
  // IPv4 address"), and deleted hosts' DNS records were never removed.
  it("updates running hosts with their own id and address and retires deleted hosts", async () => {
    const reconcileRows = [
      configRow(ADDRESS_HOST, {
        id: ADDRESS_HOST,
        status: "running",
        public_ip: "203.0.113.5",
        metadata: { public_route: { active_mode: "cloudflare-proxy" } },
        host_deleted: false,
      }),
      configRow(TUNNEL_HOST, {
        id: TUNNEL_HOST,
        status: "running",
        metadata: { cloudflare_tunnel: { id: "tunnel-2" } },
        host_deleted: false,
      }),
      configRow(DELETED_HOST, {
        id: DELETED_HOST,
        status: "deprovisioned",
        host_deleted: true,
      }),
    ];
    queryMock = jest.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM project_host_exam_configs c")) {
        return { rows: reconcileRows };
      }
      if (sql.includes("RETURNING *")) {
        return { rows: [configRow(`${params?.[0]}`, {})] };
      }
      return { rows: [] };
    });
    ensureProxiedAddressDnsMock = jest.fn(async () => ({ record_id: "a-1" }));
    ensureHostnameCnameDnsMock = jest.fn(async () => ({ record_id: "c-2" }));
    deleteHostDnsMock = jest.fn(async () => undefined);

    await reconcileExamDnsOnce();

    expect(warn).not.toHaveBeenCalled();
    const reconcileSql = queryMock.mock.calls.find(([sql]) =>
      sql.includes("FROM project_host_exam_configs c"),
    )[0];
    expect(reconcileSql).toContain("h.status='running'");

    expect(ensureProxiedAddressDnsMock).toHaveBeenCalledWith(
      expect.objectContaining({ ipAddress: "203.0.113.5" }),
    );
    expect(ensureHostnameCnameDnsMock).toHaveBeenCalledWith(
      expect.objectContaining({ target_hostname: "tunnel-2.cfargotunnel.com" }),
    );
    const updates = queryMock.mock.calls.filter(([sql]) =>
      sql.includes("SET dns_record_id=$2"),
    );
    expect(updates.map(([, params]) => params)).toEqual([
      [ADDRESS_HOST, "a-1", "203.0.113.5"],
      [TUNNEL_HOST, "c-2", "tunnel-2.cfargotunnel.com"],
    ]);

    expect(deleteHostDnsMock).toHaveBeenCalledWith({
      record_id: `record-${DELETED_HOST}`,
      name: `exam-${DELETED_HOST}-cocalc-prod.cocalc.ai`,
    });
    const retired = queryMock.mock.calls.find(([sql]) =>
      sql.includes("SET enabled=FALSE"),
    );
    expect(retired?.[1]).toEqual([DELETED_HOST]);
  });
});
