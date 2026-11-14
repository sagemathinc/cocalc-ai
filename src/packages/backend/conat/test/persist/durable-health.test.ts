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
    // counted as not FULL (the test statement guard forbids setting it)
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
