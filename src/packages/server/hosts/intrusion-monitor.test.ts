/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { HostIntrusionSnapshotResponse } from "@cocalc/conat/project-host/api";
import getPool from "@cocalc/database/pool";

import {
  diffHostIntrusionSnapshotAgainstFleet,
  diffHostIntrusionSnapshots,
  ensureHostIntrusionMonitorSchema,
  hasHostIntrusionSnapshotChanges,
  normalizeHostIntrusionSnapshot,
} from "./intrusion-monitor";

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
