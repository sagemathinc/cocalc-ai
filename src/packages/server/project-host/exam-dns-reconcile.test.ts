/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Runs reconcileExamDnsOnce against the real schema (PGlite), so the query is
// checked by the database, not a mock.

import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { reconcileExamDnsOnce, setExamConfigLocal, __test__ } from "./exam";

const mockEnsureProxiedAddressDns = jest.fn();
const mockEnsureHostnameCnameDns = jest.fn();
const mockDeleteHostnameDns = jest.fn();

jest.mock("@cocalc/database/settings/secret-settings", () => ({
  ...jest.requireActual("@cocalc/database/settings/secret-settings"),
  encryptSecretStorageValue: async (_name: string, value: string) =>
    `test-encrypted:${value}`,
  decryptSecretStorageValue: async (_name: string, value: string) => ({
    value: value.replace(/^test-encrypted:/, ""),
    needsMigration: false,
  }),
}));

jest.mock("@cocalc/server/cloud/dns", () => ({
  ensureProxiedAddressDns: (...args: any[]) =>
    mockEnsureProxiedAddressDns(...args),
  ensureHostnameCnameDns: (...args: any[]) =>
    mockEnsureHostnameCnameDns(...args),
  deleteHostnameDns: (...args: any[]) => mockDeleteHostnameDns(...args),
}));

jest.mock("@cocalc/server/cloud/public-route", () => ({
  ensureDirectCloudflareIngressForHost: async () => undefined,
}));

jest.mock("@cocalc/server/project-host/client", () => ({
  getRoutedHostControlClient: async () => ({}),
}));

jest.mock("@cocalc/server/messages/admin-alert", () => ({
  __esModule: true,
  default: jest.fn(),
}));

const account_id = randomUUID();
const ADDRESS_ROUTE = {
  public_route: { active_mode: "cloudflare-proxy" },
  runtime: { public_ip: "203.0.113.5" },
};
const TUNNEL_ROUTE = { cloudflare_tunnel: { id: "tunnel-1" } };

beforeAll(async () => {
  await initEphemeralDatabase({});
});

afterAll(async () => {
  await getPool().end();
});

beforeEach(() => {
  mockEnsureProxiedAddressDns.mockReset();
  mockEnsureHostnameCnameDns.mockReset();
  mockDeleteHostnameDns.mockReset();
  mockEnsureProxiedAddressDns.mockResolvedValue({ record_id: "a-record" });
  mockEnsureHostnameCnameDns.mockResolvedValue({ record_id: "cname-record" });
  mockDeleteHostnameDns.mockResolvedValue(undefined);
});

afterEach(async () => {
  await getPool().query("DELETE FROM project_host_exam_configs");
  await getPool().query("DELETE FROM project_hosts");
});

// A host with exam mode enabled while it was running (so its DNS was made).
async function examHost(metadata: Record<string, any>): Promise<string> {
  const id = randomUUID();
  const host = {
    id,
    name: `exam-host-${id}`,
    status: "running",
    public_url: `https://host-${id}.example.test`,
    metadata: { owner: account_id, ...metadata },
  };
  await getPool().query(
    `INSERT INTO project_hosts (id, name, status, metadata, public_url, created, updated)
     VALUES ($1, $2, 'running', $3, $4, NOW(), NOW())`,
    [id, host.name, host.metadata, host.public_url],
  );
  await setExamConfigLocal({
    host,
    actor_account_id: account_id,
    input: {
      enabled: true,
      max_projects: 10,
      project_cpu: 1,
      project_memory_mb: 2_000,
      project_disk_mb: 5_000,
      project_ttl_minutes: 6 * 60,
      cleanup_grace_minutes: 10,
    },
  });
  return id;
}

async function config(host_id: string) {
  const { rows } = await getPool().query(
    `SELECT enabled, dns_record_id, dns_target, generation
     FROM project_host_exam_configs WHERE host_id=$1`,
    [host_id],
  );
  return rows[0];
}

async function setHost(host_id: string, sql: string) {
  await getPool().query(`UPDATE project_hosts SET ${sql} WHERE id=$1`, [
    host_id,
  ]);
}

describe("examDnsAction", () => {
  it.each([
    [{ enabled: true, status: "running" }, "ensure"],
    [{ enabled: true, status: "off", dns_record_id: "r" }, "retire"],
    [{ enabled: true, status: "deprovisioned", dns_target: "t" }, "retire"],
    [{ enabled: true, status: "off" }, "skip"],
    [{ enabled: true, status: "starting", dns_record_id: "r" }, "skip"],
    [{ enabled: false, status: "running", dns_record_id: "r" }, "retire"],
    [{ enabled: false, status: "running" }, "skip"],
    [{ enabled: true, host_deleted: true }, "retire-and-disable"],
    [
      { enabled: false, host_deleted: true, dns_target: "t" },
      "retire-and-disable",
    ],
    [{ enabled: false, host_deleted: true }, "skip"],
  ])("%j -> %s", (row, action) => {
    expect(__test__.examDnsAction(row)).toBe(action);
  });
});

describe("reconcileExamDnsOnce", () => {
  it("re-ensures the DNS of running hosts with their own id and address", async () => {
    const address = await examHost(ADDRESS_ROUTE);
    const tunnel = await examHost(TUNNEL_ROUTE);
    mockEnsureProxiedAddressDns.mockResolvedValue({ record_id: "a-2" });
    mockEnsureHostnameCnameDns.mockResolvedValue({ record_id: "cname-2" });

    await reconcileExamDnsOnce();

    expect(mockEnsureProxiedAddressDns).toHaveBeenCalledWith(
      expect.objectContaining({ ipAddress: "203.0.113.5" }),
    );
    expect(await config(address)).toMatchObject({
      enabled: true,
      dns_record_id: "a-2",
      dns_target: "203.0.113.5",
    });
    expect(await config(tunnel)).toMatchObject({
      enabled: true,
      dns_record_id: "cname-2",
      dns_target: "tunnel-1.cfargotunnel.com",
    });
    expect(mockDeleteHostnameDns).not.toHaveBeenCalled();
  });

  it("removes the DNS of hosts without a live route but keeps exam mode", async () => {
    const off = await examHost(ADDRESS_ROUTE);
    const deprovisioned = await examHost(TUNNEL_ROUTE);
    await setHost(off, "status='off'");
    await setHost(deprovisioned, "status='deprovisioned', metadata='{}'");

    await reconcileExamDnsOnce();

    expect(mockDeleteHostnameDns).toHaveBeenCalledWith({
      hostname: expect.stringContaining(`exam-${off}`),
      record_id: "a-record",
    });
    for (const id of [off, deprovisioned]) {
      expect(await config(id)).toMatchObject({
        enabled: true,
        dns_record_id: null,
        dns_target: null,
      });
    }

    // Nothing left to remove: later passes leave it alone until it runs.
    mockDeleteHostnameDns.mockClear();
    await reconcileExamDnsOnce();
    expect(mockDeleteHostnameDns).not.toHaveBeenCalled();

    await setHost(off, "status='running'");
    await reconcileExamDnsOnce();
    expect(await config(off)).toMatchObject({ dns_record_id: "a-record" });
  });

  it("removes a deleted host's DNS by hostname, then disables its exam mode", async () => {
    const deleted = await examHost(TUNNEL_ROUTE);
    await setHost(deleted, "status='deprovisioned', deleted=NOW()");
    // The record id was never saved (creation succeeded, the save did not).
    await getPool().query(
      `UPDATE project_host_exam_configs SET dns_record_id=NULL WHERE host_id=$1`,
      [deleted],
    );

    await reconcileExamDnsOnce();

    expect(mockDeleteHostnameDns).toHaveBeenCalledWith({
      hostname: expect.stringContaining(`exam-${deleted}`),
      record_id: undefined,
    });
    expect(await config(deleted)).toMatchObject({
      enabled: false,
      dns_record_id: null,
      dns_target: null,
    });
  });

  it("keeps everything for a retry while a record cannot be confirmed gone", async () => {
    const deleted = await examHost(TUNNEL_ROUTE);
    await setHost(deleted, "deleted=NOW()");
    mockDeleteHostnameDns.mockRejectedValueOnce(
      new Error("1 DNS record(s) for 'x' remain after deletion"),
    );

    await reconcileExamDnsOnce();
    expect(await config(deleted)).toMatchObject({
      enabled: true,
      dns_record_id: "cname-record",
    });

    await reconcileExamDnsOnce();
    expect(await config(deleted)).toMatchObject({ enabled: false });
  });

  it("does not undo a configuration saved while its DNS was being removed", async () => {
    const off = await examHost(ADDRESS_ROUTE);
    await setHost(off, "status='off'");
    const before = await config(off);
    mockDeleteHostnameDns.mockImplementationOnce(async () => {
      await getPool().query(
        `UPDATE project_host_exam_configs SET generation=generation+1
         WHERE host_id=$1`,
        [off],
      );
    });

    await reconcileExamDnsOnce();

    expect(await config(off)).toMatchObject({
      enabled: true,
      dns_record_id: "a-record",
      generation: Number(before.generation) + 1,
    });
  });

  it("deletes a record it wrote for a configuration disabled meanwhile", async () => {
    const running = await examHost(TUNNEL_ROUTE);
    mockEnsureHostnameCnameDns.mockImplementationOnce(async () => {
      await getPool().query(
        `UPDATE project_host_exam_configs SET enabled=FALSE WHERE host_id=$1`,
        [running],
      );
      return { record_id: "cname-late" };
    });

    await reconcileExamDnsOnce();

    expect(mockDeleteHostnameDns).toHaveBeenCalledWith({
      hostname: expect.stringContaining(`exam-${running}`),
      record_id: "cname-late",
    });
  });
});
