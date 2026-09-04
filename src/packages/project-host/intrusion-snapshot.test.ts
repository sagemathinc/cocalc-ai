/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { HostIntrusionSnapshotResponse } from "@cocalc/conat/project-host/api";

import {
  collectIntrusionSnapshot,
  parseIntrusionSnapshot,
} from "./intrusion-snapshot";

function snapshot(): HostIntrusionSnapshotResponse {
  return {
    version: 2,
    captured_at: "2026-09-01T00:00:00.000Z",
    duration_ms: 12,
    hostname: "host-1",
    kernel: "6.8.0",
    boot_id: "boot-id",
    coverage: "complete",
    accounts: { uid_zero: [], interactive: [] },
    host_processes: {
      scanned_process_count: 10,
      process_count: 2,
      summary: [],
      findings: [],
    },
    persistence: { files: [], truncated: false },
    privileged_files: { writable: [], suid_sgid: [], capabilities: [] },
    services: { enabled: [], failed: [] },
    network: { listeners: [], established: [] },
    authentication_7d: { accepted: [], failed: 0, invalid_user: 0 },
    kernel_signals_7d: {},
    package_integrity: { manager: "dpkg", differences: [] },
    issues: [],
    truncated: {},
  };
}

describe("host intrusion snapshot", () => {
  it("runs only the fixed no-argument root helper command", async () => {
    const execute = jest.fn(async () => ({
      exit_code: 0,
      stdout: JSON.stringify(snapshot()),
      stderr: "",
    }));

    const result = await collectIntrusionSnapshot({ execute: execute as any });

    expect(result).toEqual(snapshot());
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "sudo",
        args: [
          "-n",
          "/usr/local/sbin/cocalc-project-host-rootctl",
          "intrusion-snapshot",
        ],
        timeout: 120,
        max_output: 512 * 1024,
        err_on_exit: false,
      }),
    );
  });

  it("fails closed without returning helper stderr", async () => {
    const result = await collectIntrusionSnapshot({
      execute: (async () => ({
        exit_code: 2,
        stdout: "",
        stderr: "sensitive host detail",
      })) as any,
    });

    expect(result.coverage).toBe("unavailable");
    expect(result.issues).toEqual([
      { section: "collector", code: "ROOT_HELPER_FAILED" },
    ]);
    expect(JSON.stringify(result)).not.toContain("sensitive host detail");
  });

  it("rejects malformed or incomplete helper output", () => {
    expect(() => parseIntrusionSnapshot("{}")).toThrow(
      "invalid intrusion snapshot response",
    );
    expect(() =>
      parseIntrusionSnapshot(
        JSON.stringify({ ...snapshot(), host_processes: undefined }),
      ),
    ).toThrow("invalid intrusion snapshot response");
    expect(() =>
      parseIntrusionSnapshot(
        JSON.stringify({
          ...snapshot(),
          network: { listeners: "not-an-array", established: [] },
        }),
      ),
    ).toThrow("invalid intrusion snapshot response");
    expect(() => parseIntrusionSnapshot("x".repeat(512 * 1024))).toThrow(
      "intrusion snapshot exceeded output limit",
    );
  });

  it("accepts legacy version 1 snapshots during rolling upgrades", () => {
    const legacy = { ...snapshot(), version: 1 as const };

    expect(parseIntrusionSnapshot(JSON.stringify(legacy))).toEqual(legacy);
    expect(() =>
      parseIntrusionSnapshot(JSON.stringify({ ...legacy, version: 3 })),
    ).toThrow("invalid intrusion snapshot response");
  });
});
