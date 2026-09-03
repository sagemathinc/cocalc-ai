/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { HostIntrusionSnapshotResponse } from "@cocalc/conat/project-host/api";
import getPool from "@cocalc/database/pool";

const mockAdminAlert = jest.fn();
const mockGetIntrusionSnapshot = jest.fn();

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "intrusion-monitor-test",
}));
jest.mock("@cocalc/server/messages/admin-alert", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockAdminAlert(...args),
}));
jest.mock("@cocalc/server/project-host/client", () => ({
  getRoutedHostControlClient: async () => ({
    getIntrusionSnapshot: () => mockGetIntrusionSnapshot(),
  }),
}));

import {
  activeFleetHasCompleteBaseline,
  diffHostIntrusionSnapshotAgainstFleet,
  diffHostIntrusionSnapshots,
  ensureHostIntrusionMonitorSchema,
  hasHostIntrusionSnapshotChanges,
  normalizeHostIntrusionSnapshot,
  reachedCoverageFailureThreshold,
  runHostIntrusionMonitorPass,
} from "./intrusion-monitor";

async function ensureProjectHostsTestTable(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS project_hosts (
      id UUID PRIMARY KEY,
      name TEXT,
      public_url TEXT,
      bay_id TEXT,
      status TEXT,
      last_seen TIMESTAMPTZ,
      created TIMESTAMPTZ,
      updated TIMESTAMPTZ,
      deleted TIMESTAMPTZ
    )
  `);
}

function snapshot(): HostIntrusionSnapshotResponse {
  return {
    version: 1,
    captured_at: "2026-09-02T00:00:00.000Z",
    duration_ms: 100,
    hostname: "host-1",
    kernel: "6.8.0",
    boot_id: "boot-1",
    coverage: "complete",
    accounts: {
      uid_zero: [
        {
          name: "root",
          uid: 0,
          gid: 0,
          home: "/root",
          shell: "/bin/bash",
        },
      ],
      interactive: [],
    },
    host_processes: {
      scanned_process_count: 100,
      process_count: 1,
      summary: [
        {
          count: 1,
          uid: 0,
          comm: "systemd",
          exe: "/usr/lib/systemd/systemd",
          capability_mask: "000001ffffffffff",
          executable_uid: 0,
          executable_mode: "0755",
        },
      ],
      findings: [],
    },
    persistence: {
      files: [
        {
          path: "/etc/systemd/system/example.service",
          uid: 0,
          gid: 0,
          mode: "0644",
          mtime: "2026-09-01T00:00:00.000Z",
          size: 100,
          type: "file",
          sha256: "hash-1",
        },
      ],
      truncated: false,
    },
    privileged_files: {
      writable: [],
      suid_sgid: ["/usr/bin/passwd\t0:0\t4755"],
      capabilities: [],
    },
    services: {
      enabled: ["sshd.service enabled"],
      failed: [],
    },
    network: {
      listeners: [
        {
          count: 1,
          protocol: "tcp",
          process: "sshd",
          local: "0.0.0.0:22",
        },
      ],
      established: [
        {
          count: 1,
          process: "cloudflared",
          local_port: "50000",
          peer: "198.51.100.1:443",
        },
      ],
    },
    authentication_7d: {
      accepted: [
        {
          count: 1,
          method: "publickey",
          user: "ubuntu",
          source: "192.0.2.10",
        },
      ],
      failed: 2,
      invalid_user: 1,
    },
    kernel_signals_7d: { oom: 1 },
    package_integrity: { manager: "dpkg", differences: [] },
    issues: [],
    truncated: {},
  };
}

describe("project-host intrusion monitor normalization", () => {
  it("creates durable snapshot storage with a coverage constraint", async () => {
    await ensureHostIntrusionMonitorSchema();
    const id = "07960b11-b7de-4b8a-b88b-c91bdc7b6838";
    const hostId = "3538cd96-708e-4b89-90dd-7fb7ebee7341";
    await getPool().query(
      `INSERT INTO project_host_intrusion_snapshots
         (id, host_id, bay_id, captured_at, duration_ms, coverage,
          normalization_version, normalized)
       VALUES ($1, $2, 'test', NOW(), 1, 'complete', 1, '{}'::jsonb)`,
      [id, hostId],
    );
    const { rows } = await getPool().query(
      `SELECT coverage FROM project_host_intrusion_snapshots WHERE id=$1`,
      [id],
    );
    expect(rows[0]?.coverage).toBe("complete");
    await getPool().query(
      `DELETE FROM project_host_intrusion_snapshots WHERE id=$1`,
      [id],
    );
  });

  it("does not treat retired hosts as an active fleet baseline", async () => {
    await ensureHostIntrusionMonitorSchema();
    const id = "864f72a8-f1f7-47e4-a758-b358e52b019e";
    const hostId = "1bcc01ce-80f3-4c4d-9c84-f5d82caa48c3";
    const bayId = "intrusion-monitor-test";
    const pool = getPool();
    await ensureProjectHostsTestTable();
    try {
      await pool.query(
        `INSERT INTO project_hosts
           (id, name, bay_id, status, last_seen, created, updated)
         VALUES ($1, 'retired-baseline', $2, 'running',
                 NOW() - INTERVAL '10 minutes', NOW(), NOW())`,
        [hostId, bayId],
      );
      await pool.query(
        `INSERT INTO project_host_intrusion_snapshots
           (id, host_id, bay_id, captured_at, duration_ms, coverage,
            normalization_version, normalized)
         VALUES ($1, $2, $3, NOW(), 1, 'complete', 1, '{}'::jsonb)`,
        [id, hostId, bayId],
      );

      await expect(activeFleetHasCompleteBaseline(bayId)).resolves.toBe(false);

      await pool.query("UPDATE project_hosts SET last_seen=NOW() WHERE id=$1", [
        hostId,
      ]);
      await expect(activeFleetHasCompleteBaseline(bayId)).resolves.toBe(true);

      await pool.query("UPDATE project_hosts SET deleted=NOW() WHERE id=$1", [
        hostId,
      ]);
      await expect(activeFleetHasCompleteBaseline(bayId)).resolves.toBe(false);
    } finally {
      await pool.query(
        "DELETE FROM project_host_intrusion_snapshots WHERE id=$1",
        [id],
      );
      await pool.query("DELETE FROM project_hosts WHERE id=$1", [hostId]);
    }
  });

  it("alerts on the third consecutive incomplete coverage result", () => {
    expect(
      reachedCoverageFailureThreshold([
        { coverage: "partial" },
        { coverage: "unavailable" },
        { coverage: "complete" },
      ]),
    ).toBe(true);
    expect(
      reachedCoverageFailureThreshold([
        { coverage: "partial" },
        { coverage: "complete" },
      ]),
    ).toBe(false);
  });

  it("does not promote a baseline until its alert is delivered", async () => {
    await ensureHostIntrusionMonitorSchema();
    await ensureProjectHostsTestTable();
    const hostId = "83ce7448-8b5f-4b28-a531-f728067bf2b4";
    const pool = getPool();
    mockAdminAlert.mockReset();
    mockGetIntrusionSnapshot.mockReset();
    mockGetIntrusionSnapshot.mockResolvedValue(snapshot());
    await pool.query(
      `INSERT INTO project_hosts
         (id, name, bay_id, status, last_seen, created, updated)
       VALUES ($1, 'new-host', 'intrusion-monitor-test', 'running',
               NOW(), NOW(), NOW())`,
      [hostId],
    );
    try {
      mockAdminAlert.mockRejectedValueOnce(
        new Error("notification unavailable"),
      );
      await expect(runHostIntrusionMonitorPass()).rejects.toThrow(
        "notification unavailable",
      );
      let result = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM project_host_intrusion_snapshots
          WHERE host_id=$1 AND coverage='complete'`,
        [hostId],
      );
      expect(result.rows[0]?.count).toBe("0");

      mockAdminAlert.mockResolvedValueOnce(undefined);
      await expect(runHostIntrusionMonitorPass()).resolves.toMatchObject({
        checked: 1,
        baselined: 1,
      });
      result = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM project_host_intrusion_snapshots
          WHERE host_id=$1 AND coverage='complete'`,
        [hostId],
      );
      expect(result.rows[0]?.count).toBe("1");
    } finally {
      await pool.query(
        "DELETE FROM project_host_intrusion_snapshots WHERE host_id=$1",
        [hostId],
      );
      await pool.query("DELETE FROM project_hosts WHERE id=$1", [hostId]);
      mockAdminAlert.mockReset();
      mockGetIntrusionSnapshot.mockReset();
    }
  });

  it("does not promote a changed baseline until its alert is delivered", async () => {
    await ensureHostIntrusionMonitorSchema();
    await ensureProjectHostsTestTable();
    const snapshotId = "1f56604f-93cf-40d9-a16f-7648490b9945";
    const hostId = "03cad6ab-4c33-48ad-a46b-824a5a0407b7";
    const pool = getPool();
    const current = snapshot();
    current.services.enabled.push("unexpected.service enabled");
    mockAdminAlert.mockReset();
    mockGetIntrusionSnapshot.mockReset();
    mockGetIntrusionSnapshot.mockResolvedValue(current);
    await pool.query(
      `INSERT INTO project_hosts
         (id, name, bay_id, status, last_seen, created, updated)
       VALUES ($1, 'changed-host', 'intrusion-monitor-test', 'running',
               NOW(), NOW(), NOW())`,
      [hostId],
    );
    await pool.query(
      `INSERT INTO project_host_intrusion_snapshots
         (id, host_id, bay_id, captured_at, duration_ms, coverage,
          normalization_version, normalized)
       VALUES ($1, $2, 'intrusion-monitor-test', NOW(), 1, 'complete',
               1, $3::jsonb)`,
      [
        snapshotId,
        hostId,
        JSON.stringify(normalizeHostIntrusionSnapshot(snapshot())),
      ],
    );
    try {
      mockAdminAlert.mockRejectedValueOnce(
        new Error("notification unavailable"),
      );
      await expect(runHostIntrusionMonitorPass()).rejects.toThrow(
        "notification unavailable",
      );
      let result = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM project_host_intrusion_snapshots
          WHERE host_id=$1 AND coverage='complete'`,
        [hostId],
      );
      expect(result.rows[0]?.count).toBe("1");

      mockAdminAlert.mockResolvedValueOnce(undefined);
      await expect(runHostIntrusionMonitorPass()).resolves.toMatchObject({
        checked: 1,
        changed: 1,
      });
      result = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM project_host_intrusion_snapshots
          WHERE host_id=$1 AND coverage='complete'`,
        [hostId],
      );
      expect(result.rows[0]?.count).toBe("2");
    } finally {
      await pool.query(
        "DELETE FROM project_host_intrusion_snapshots WHERE host_id=$1",
        [hostId],
      );
      await pool.query("DELETE FROM project_hosts WHERE id=$1", [hostId]);
      mockAdminAlert.mockReset();
      mockGetIntrusionSnapshot.mockReset();
    }
  });

  it("does not alert on volatile timestamps, pids, counts, or connections", () => {
    const before = snapshot();
    before.host_processes.findings = [
      {
        pid: 100,
        uid: 0,
        comm: "worker",
        exe: "/usr/local/bin/worker",
        capability_mask: "0",
        flags: ["deleted-executable"],
      },
    ];
    const after = structuredClone(before);
    after.captured_at = "2026-09-02T04:00:00.000Z";
    after.duration_ms = 999;
    after.boot_id = "boot-2";
    after.host_processes.scanned_process_count = 150;
    after.host_processes.process_count = 3;
    after.host_processes.summary[0].count = 3;
    after.host_processes.findings[0].pid = 999;
    after.persistence.files[0].mtime = "2026-09-02T03:00:00.000Z";
    after.persistence.files[0].size = 101;
    after.network.listeners[0].count = 5;
    after.network.established = [
      {
        count: 20,
        process: "cloudflared",
        local_port: "50001",
        peer: "198.51.100.2:443",
      },
    ];
    after.authentication_7d.accepted[0].count = 4;
    after.authentication_7d.failed = 20;
    after.authentication_7d.invalid_user = 10;
    after.kernel_signals_7d.oom = 4;

    const delta = diffHostIntrusionSnapshots(
      normalizeHostIntrusionSnapshot(before),
      normalizeHostIntrusionSnapshot(after),
    );

    expect(delta).toEqual({ added: {}, removed: {} });
    expect(hasHostIntrusionSnapshotChanges(delta)).toBe(false);
  });

  it("does not alert on expected maintenance processes or rotating listeners", () => {
    const before = snapshot();
    before.network.listeners.push(
      {
        count: 1,
        protocol: "tcp",
        process: "project-host:ac",
        local: "0.0.0.0:16607",
      },
      {
        count: 1,
        protocol: "udp",
        process: "cloudflared",
        local: "*:64979",
      },
    );
    const after = structuredClone(before);
    after.network.listeners[1].local = "0.0.0.0:28003";
    after.network.listeners[2].local = "*:13887";
    after.host_processes.summary.push(
      {
        count: 1,
        uid: 0,
        comm: "btrfs",
        exe: "/usr/bin/btrfs",
        capability_mask: "000001ffffffffff",
        executable_uid: 0,
        executable_mode: "0755",
      },
      {
        count: 1,
        uid: 105,
        comm: "sshd",
        exe: "/usr/sbin/sshd",
        capability_mask: "0",
        executable_uid: 0,
        executable_mode: "0755",
      },
      {
        count: 1,
        uid: 2000,
        comm: "bash",
        exe: "/usr/bin/bash",
        capability_mask: "0",
        executable_uid: 0,
        executable_mode: "0755",
      },
      {
        count: 1,
        uid: 2000,
        comm: "rustic",
        exe: "/opt/cocalc/tools/20260903-release/rustic",
        capability_mask: "0",
        executable_uid: 2000,
        executable_mode: "0755",
      },
      {
        count: 1,
        uid: 2000,
        comm: "sleep",
        exe: "/usr/bin/sleep",
        capability_mask: "0",
        executable_uid: 0,
        executable_mode: "0755",
      },
    );

    const delta = diffHostIntrusionSnapshots(
      normalizeHostIntrusionSnapshot(before),
      normalizeHostIntrusionSnapshot(after),
    );

    expect(delta).toEqual({ added: {}, removed: {} });
  });

  it("still alerts on unknown processes and fixed listener changes", () => {
    const before = snapshot();
    before.network.listeners.push({
      count: 1,
      protocol: "tcp",
      process: "project-host:ap",
      local: "127.0.0.1:9003",
    });
    const after = structuredClone(before);
    after.network.listeners[1].local = "0.0.0.0:9003";
    after.host_processes.summary.push({
      count: 1,
      uid: 2000,
      comm: "python3",
      exe: "/usr/bin/python3.12",
      capability_mask: "0",
      executable_uid: 0,
      executable_mode: "0755",
    });
    after.host_processes.summary.push({
      count: 1,
      uid: 2000,
      comm: "bash",
      exe: "/usr/bin/bash",
      capability_mask: "0000000000000001",
      executable_uid: 0,
      executable_mode: "0755",
    });

    const delta = diffHostIntrusionSnapshots(
      normalizeHostIntrusionSnapshot(before),
      normalizeHostIntrusionSnapshot(after),
    );

    expect(delta.added["host_processes.summary"]).toHaveLength(2);
    expect(delta.added["host_processes.summary"]?.join("\n")).toContain(
      "python3",
    );
    expect(delta.added["host_processes.summary"]?.join("\n")).toContain("bash");
    expect(delta.added["network.listeners"]).toEqual([
      '["tcp","project-host:ap","0.0.0.0:9003"]',
    ]);
    expect(delta.removed["network.listeners"]).toEqual([
      '["tcp","project-host:ap","127.0.0.1:9003"]',
    ]);
  });

  it("still alerts on a maintenance-user shell without an active backup", () => {
    const before = snapshot();
    const after = structuredClone(before);
    after.host_processes.summary.push({
      count: 1,
      uid: 2000,
      comm: "bash",
      exe: "/usr/bin/bash",
      capability_mask: "0000000000000000",
      executable_uid: 0,
      executable_mode: "0755",
    });

    const delta = diffHostIntrusionSnapshots(
      normalizeHostIntrusionSnapshot(before),
      normalizeHostIntrusionSnapshot(after),
    );

    expect(delta.added["host_processes.summary"]?.[0]).toContain("bash");
  });

  it("detects stable security-state additions and removals", () => {
    const before = snapshot();
    const after = structuredClone(before);
    after.persistence.files[0].sha256 = "hash-2";
    after.host_processes.summary.push({
      count: 1,
      uid: 1000,
      comm: "miner",
      exe: "/home/ubuntu/miner",
      capability_mask: "0",
      executable_uid: 1000,
      executable_mode: "0755",
    });
    after.network.listeners = [];

    const delta = diffHostIntrusionSnapshots(
      normalizeHostIntrusionSnapshot(before),
      normalizeHostIntrusionSnapshot(after),
    );

    expect(delta.added["persistence.files"]).toHaveLength(1);
    expect(delta.removed["persistence.files"]).toHaveLength(1);
    expect(delta.added["host_processes.summary"]?.[0]).toContain("miner");
    expect(delta.removed["network.listeners"]).toHaveLength(1);
    expect(hasHostIntrusionSnapshotChanges(delta)).toBe(true);
  });

  it("does not alert when rolling-window evidence ages out", () => {
    const before = snapshot();
    const after = structuredClone(before);
    after.authentication_7d.accepted = [];
    after.kernel_signals_7d = {};

    const delta = diffHostIntrusionSnapshots(
      normalizeHostIntrusionSnapshot(before),
      normalizeHostIntrusionSnapshot(after),
    );

    expect(delta).toEqual({ added: {}, removed: {} });
  });

  it("uses active fleet observations for a new host without treating omissions as changes", () => {
    const peer1 = normalizeHostIntrusionSnapshot(snapshot());
    const secondSource = snapshot();
    secondSource.services.enabled.push("timer.service enabled");
    const peer2 = normalizeHostIntrusionSnapshot(secondSource);
    const currentSource = snapshot();
    currentSource.services.enabled = [
      "sshd.service enabled",
      "timer.service enabled",
      "unexpected.service enabled",
    ];
    currentSource.network.listeners = [];

    const delta = diffHostIntrusionSnapshotAgainstFleet(
      [peer1, peer2],
      normalizeHostIntrusionSnapshot(currentSource),
    );

    expect(delta.added).toEqual({
      "services.enabled": ["unexpected.service enabled"],
    });
    expect(delta.removed).toEqual({});
  });
});
