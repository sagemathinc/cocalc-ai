/*
Finding 028 B-3a: durability health in the persist diagnostics (DESIGN v1.21
§3.2.10 alert routing, §3.2.3 host health, §3.2.0 the user-writable rule).
Only a DEVICE-class poison of a file the user cannot write marks the host
unhealthy; a quota (Q-F) project poison and a failed verification never do.
*/

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pstream } from "@cocalc/backend/conat/persist";
import { persistOpenBarrier } from "@cocalc/backend/conat/persist-open-barrier";
import {
  clearOpenBarrierPass,
  getPersistentStreamDiagnostics,
  prepareDurableOpen,
} from "@cocalc/conat/persist/storage";

describe("028 B-3a: durability health", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "persist-028-health-"));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  const health = () => (getPersistentStreamDiagnostics() as any).durability;

  it("starts healthy, with every counter present", () => {
    const h = health();
    expect(h).toMatchObject({
      device_poisons_total: 0,
      project_poisons_total: 0,
      verification_failures_total: 0,
      parked_streams: 0,
      startup_refused: null,
      host_healthy: true,
    });
    expect(typeof h.budget_refused_total).toBe("number");
    // SA 3351 A1: the test setup's overrides are visible
    expect(h.startup_overrides).toEqual([
      "COCALC_PERSIST_RECORDS_ALLOW_TEST_PATHS",
      "COCALC_PERSIST_RECORDS_BASE",
    ]);
    // ALT-D2 runtime proof (a): the records root's path, dev/ino and the T1
    // result are published; the sentinel token never is
    const r = h.startup_records;
    expect(r).toMatchObject({ records_ok: true, records_t1: "pass" });
    expect(r.records_root).toBe(
      join(process.env.COCALC_PERSIST_RECORDS_BASE!, "records", r.records_root.split("/").pop()),
    );
    expect(r.records_root_dev).toMatch(/^\d+$/);
    expect(r.records_root_ino).toMatch(/^\d+$/);
    const sentinel = JSON.parse(
      require("node:fs").readFileSync(join(r.records_root, "sentinel.json"), "utf8"),
    );
    expect(JSON.stringify(getPersistentStreamDiagnostics())).not.toContain(sentinel.token);
    expect(typeof h.msgid_conflicts_total).toBe("number");
  });

  it("the runtime PRAGMA check reads back every open disk connection: all FULL, auto-checkpoint 0", async () => {
    const a = pstream({ path: join(dir, "p1") });
    const b = pstream({ path: join(dir, "p2") });
    const eph = pstream({ path: join(dir, "e"), ephemeral: true });
    const pc = (getPersistentStreamDiagnostics() as any).pragma_check;
    expect(pc.disk_connections).toBeGreaterThanOrEqual(2);
    expect(pc.synchronous_full).toBe(pc.disk_connections);
    expect(pc.wal_autocheckpoint_off).toBe(pc.disk_connections);
    expect(pc.unreadable).toBe(0);
    // can fail: a connection that reads back OFF (0) / auto-checkpoint on is
    // counted as not FULL (a stubbed read-back; the next test sets a REAL
    // wrong value)
    const spy = jest
      .spyOn(a as any, "readDurabilityPragmas")
      .mockReturnValue({ synchronous: 0, walAutocheckpoint: 1000 });
    const pc2 = (getPersistentStreamDiagnostics() as any).pragma_check;
    expect(pc2.synchronous_full).toBe(pc2.disk_connections - 1);
    expect(pc2.wal_autocheckpoint_off).toBe(pc2.disk_connections - 1);
    spy.mockRestore();
    a.close();
    b.close();
    eph.close();
  });

  it("the PRAGMA check reads back a REAL wrong setting on a registered stream", () => {
    const a = pstream({ path: join(dir, "real1") });
    const b = pstream({ path: join(dir, "real2") });
    const pc = (getPersistentStreamDiagnostics() as any).pragma_check;
    expect(pc.synchronous_full).toBe(pc.disk_connections);
    // a connection setting (writes nothing): the read-back sees NORMAL (1)
    (a as any).db.exec("PRAGMA synchronous=NORMAL");
    expect((a as any).readDurabilityPragmas().synchronous).toBe(1);
    const pc2 = (getPersistentStreamDiagnostics() as any).pragma_check;
    expect(pc2.synchronous_full).toBe(pc2.disk_connections - 1);
    (a as any).db.exec("PRAGMA synchronous=FULL");
    a.close();
    b.close();
  });

  it("every LIVE disk connection is read back, also one whose close failed (outside the registered streams)", () => {
    const a = pstream({ path: join(dir, "live1") });
    const b = pstream({ path: join(dir, "live2") });
    const before = (getPersistentStreamDiagnostics() as any).pragma_check;
    expect(before.unregistered_live).toBe(0);
    expect(before.disk_connections).toBe(before.registered_streams);
    // b: a wrong setting, then a close that can't be armed: its connection
    // stays open (liveDiskConnections) but leaves the registered streams
    (b as any).db.exec("PRAGMA synchronous=NORMAL");
    const arm = jest
      .spyOn(b as any, "armBeforeWrite")
      .mockImplementation(() => {
        throw Error("unarmed (test)");
      });
    (b as any).finishClose(join(dir, "live2"));
    arm.mockRestore();
    const pc = (getPersistentStreamDiagnostics() as any).pragma_check;
    expect(pc.unregistered_live).toBe(1);
    expect(pc.registered_streams).toBe(before.registered_streams - 1);
    expect(pc.disk_connections).toBe(before.disk_connections);
    // not green: the retained connection is measured (registered streams
    // only would show every connection FULL)
    expect(pc.synchronous_full).toBe(pc.disk_connections - 1);
    // clean up: close b's connection for real
    expect((b as any).closeConnection()).toBe(true);
    const after = (getPersistentStreamDiagnostics() as any).pragma_check;
    expect(after.unregistered_live).toBe(0);
    a.close();
  });

  it("a quota (Q-F) poison counts as a project poison and keeps the host healthy", async () => {
    const path = join(dir, "qf");
    jest.spyOn(persistOpenBarrier, "run").mockResolvedValue({
      kind: "sync-error",
      path: `${path}.db`,
      errno: "EDQUOT",
      synced: [],
    });
    await expect(
      prepareDurableOpen(path, "cccccccc-2222-4333-8444-555555555555"),
    ).rejects.toThrow("had a sync error");
    expect(health()).toMatchObject({ project_poisons_total: 1, host_healthy: true });
  });

  it("a device-class poison (EIO from an fsync) of a host-owned file marks the host unhealthy", async () => {
    const path = join(dir, "eio");
    jest.spyOn(persistOpenBarrier, "run").mockResolvedValue({
      kind: "sync-error",
      path: `${path}.db`,
      errno: "EIO",
      synced: [],
    });
    await expect(prepareDurableOpen(path, "host")).rejects.toThrow(
      "had a sync error",
    );
    expect(health()).toMatchObject({ host_healthy: false });
    expect(health().device_poisons_total).toBeGreaterThanOrEqual(1);
    clearOpenBarrierPass(path);
  });
});
