/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import centralLog from "@cocalc/database/postgres/central-log";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { getRoutedHostControlClient } from "@cocalc/server/project-host/client";

import {
  describe as describeHost,
  intrusionSnapshot,
  scanAbuseFilesystems,
  scanAbuseProcesses,
} from "./admin-host";

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("@cocalc/database/postgres/central-log", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("@cocalc/server/project-host/client", () => ({
  getRoutedHostControlClient: jest.fn(),
}));

const mockGetPool = jest.mocked(getPool);
const mockCentralLog = jest.mocked(centralLog);
const mockIsAdmin = jest.mocked(isAdmin);
const mockGetRoutedHostControlClient = jest.mocked(getRoutedHostControlClient);

describe("admin host API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAdmin.mockResolvedValue(true);
    mockCentralLog.mockResolvedValue(undefined);
  });

  it("counts project runtime state using the JSON state field", async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("FROM project_hosts")) {
        return {
          rows: [
            {
              id: "7843c648-86e4-45d3-9ed2-85ebe9faf9ee",
              name: "host",
              status: "running",
              last_seen: new Date("2026-07-08T19:00:00Z"),
              capacity: {},
              metadata: {},
            },
          ],
        };
      }
      if (sql.includes("FROM projects")) {
        return {
          rows: [
            {
              total: 3,
              running: 1,
              stopped: 2,
              provisioned: 3,
              not_provisioned: 0,
            },
          ],
        };
      }
      if (sql.includes("FROM long_running_operations")) {
        return { rows: [] };
      }
      if (sql.includes("FROM project_host_availability_events")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    mockGetPool.mockReturnValue({ query } as any);

    const result = await describeHost({
      account_id: "account-id",
      host_id: "7843c648-86e4-45d3-9ed2-85ebe9faf9ee",
      include_live: false,
      reason: "test",
    });

    const projectCountSql = query.mock.calls
      .map(([sql]) => sql)
      .find((sql) => `${sql}`.includes("FROM projects"));
    expect(projectCountSql).toContain("state->>'state'");
    expect(projectCountSql).not.toContain("WHERE state='running'");
    expect(result.project_counts).toMatchObject({ running: 1, stopped: 2 });
    expect(mockGetRoutedHostControlClient).not.toHaveBeenCalled();
  });

  it("returns an audited bounded abuse process snapshot", async () => {
    const hostId = "7843c648-86e4-45d3-9ed2-85ebe9faf9ee";
    mockGetPool.mockReturnValue({
      query: jest.fn(async () => ({
        rows: [{ id: hostId, name: "host", status: "running" }],
      })),
    } as any);
    const getAbuseProcessSnapshot = jest.fn(async () => ({
      version: 1 as const,
      coverage: "complete" as const,
      captured_at: "2026-08-19T00:00:00.000Z",
      duration_ms: 4,
      project_count: 1,
      active_project_count: 1,
      cgroup_count: 1,
      process_count: 1,
      vanished_process_count: 0,
      projects: [],
      issues: [],
      truncated: {
        projects: false,
        processes: false,
        deadline: false,
        issues: false,
      },
    }));
    mockGetRoutedHostControlClient.mockResolvedValue({
      getAbuseProcessSnapshot,
    } as any);

    const result = await scanAbuseProcesses({
      account_id: "account-id",
      host_id: hostId,
      max_projects: 999_999,
      max_processes: 999_999,
      timeout_ms: 999_999,
      reason: "abuse triage",
    });

    expect(getAbuseProcessSnapshot).toHaveBeenCalledWith({
      max_projects: 5_000,
      max_processes: 50_000,
      timeout_ms: 15_000,
    });
    expect(result.snapshot.coverage).toBe("complete");
    expect(mockCentralLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "admin_host_operator",
        value: expect.objectContaining({
          mode: "abuse-processes",
          reason: "abuse triage",
        }),
      }),
    );
  });

  it("returns an audited bounded abuse filesystem snapshot", async () => {
    const hostId = "7843c648-86e4-45d3-9ed2-85ebe9faf9ee";
    mockGetPool.mockReturnValue({
      query: jest.fn(async () => ({
        rows: [{ id: hostId, name: "host", status: "running" }],
      })),
    } as any);
    const getAbuseFilesystemSnapshot = jest.fn(async () => ({
      version: 1 as const,
      fingerprint_version: "tree-metadata-v1" as const,
      coverage: "complete" as const,
      captured_at: "2026-08-19T00:00:00.000Z",
      duration_ms: 4,
      project_count: 1,
      fingerprint_count: 1,
      total_entry_count: 10,
      missing_project_count: 0,
      skipped_large_project_count: 0,
      projects: [],
      issues: [],
      truncated: {
        projects: false,
        total_entries: false,
        deadline: false,
        issues: false,
      },
    }));
    mockGetRoutedHostControlClient.mockResolvedValue({
      getAbuseFilesystemSnapshot,
    } as any);

    const result = await scanAbuseFilesystems({
      account_id: "account-id",
      host_id: hostId,
      max_projects: 999_999,
      max_entries_per_project: 999_999,
      max_total_entries: 999_999,
      max_depth: 999_999,
      timeout_ms: 999_999,
      reason: "filesystem fingerprint triage",
    });

    expect(getAbuseFilesystemSnapshot).toHaveBeenCalledWith({
      max_projects: 5_000,
      max_entries_per_project: 10_000,
      max_total_entries: 250_000,
      max_depth: 8,
      timeout_ms: 30_000,
    });
    expect(result.snapshot.coverage).toBe("complete");
    expect(mockCentralLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "admin_host_operator",
        value: expect.objectContaining({
          mode: "abuse-filesystems",
          reason: "filesystem fingerprint triage",
        }),
      }),
    );
  });

  it("routes and audits the read-only intrusion snapshot", async () => {
    const hostId = "7843c648-86e4-45d3-9ed2-85ebe9faf9ee";
    mockGetPool.mockReturnValue({
      query: jest.fn(async () => ({
        rows: [{ id: hostId, name: "host", status: "running" }],
      })),
    } as any);
    const getIntrusionSnapshot = jest.fn(async () => ({
      version: 1 as const,
      coverage: "complete" as const,
      issues: [],
      truncated: {},
    }));
    mockGetRoutedHostControlClient.mockResolvedValue({
      getIntrusionSnapshot,
    } as any);

    const result = await intrusionSnapshot({
      account_id: "account-id",
      host_id: hostId,
      reason: "host integrity review",
    });

    expect(getIntrusionSnapshot).toHaveBeenCalledWith();
    expect(result.snapshot.coverage).toBe("complete");
    expect(mockCentralLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "admin_host_operator",
        value: expect.objectContaining({
          mode: "intrusion-snapshot",
          reason: "host integrity review",
        }),
      }),
    );
  });
});
