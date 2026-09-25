/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase } from "@cocalc/lite/hub/sqlite/database";
import {
  listLeasedMaintenanceSchedules,
  listPendingMaintenanceReports,
  listRecentMaintenanceAttempts,
  MAX_MAINTENANCE_OWNERSHIP_LEASE_MS,
  markMaintenanceReportDelivered,
  saveMaintenanceReport,
  saveValidatedMaintenanceSchedules,
} from "./maintenance-ledger";

describe("project maintenance report ledger", () => {
  it("replays each distinct attempt in order and retains bounded history", () => {
    const oldFilename = process.env.COCALC_LITE_SQLITE_FILENAME;
    process.env.COCALC_LITE_SQLITE_FILENAME = ":memory:";
    closeDatabase();
    try {
      const first = {
        project_id: "project-1",
        host_id: "host-1",
        kind: "backup" as const,
        observed_at: "2026-09-23T10:00:00.000Z",
        outcome: "failed" as const,
        stage_durations_ms: { inventory: 25 },
      };
      const second = {
        ...first,
        observed_at: "2026-09-23T10:01:00.000Z",
        outcome: "succeeded" as const,
      };
      saveMaintenanceReport(first);
      saveMaintenanceReport(second);
      expect(listPendingMaintenanceReports()).toEqual([first, second]);
      markMaintenanceReportDelivered(first);
      expect(listPendingMaintenanceReports()).toEqual([second]);
      expect(listRecentMaintenanceAttempts({ projectId: "project-1" })).toEqual(
        [second, first],
      );
    } finally {
      closeDatabase();
      if (oldFilename == null) delete process.env.COCALC_LITE_SQLITE_FILENAME;
      else process.env.COCALC_LITE_SQLITE_FILENAME = oldFilename;
    }
  });

  it("bounds delivered attempts without deleting pending attempts", () => {
    const oldFilename = process.env.COCALC_LITE_SQLITE_FILENAME;
    process.env.COCALC_LITE_SQLITE_FILENAME = ":memory:";
    closeDatabase();
    try {
      for (let i = 0; i < 140; i++) {
        const report = {
          project_id: "project-1",
          host_id: "host-1",
          kind: "snapshot" as const,
          observed_at: new Date(Date.UTC(2026, 8, 23, 10, 0, i)).toISOString(),
          outcome: "succeeded" as const,
          latest_snapshot_at: new Date(
            Date.UTC(2026, 8, 23, 10, 0, i),
          ).toISOString(),
        };
        saveMaintenanceReport(report);
        if (i !== 0) markMaintenanceReportDelivered(report);
      }
      const count = getDatabase()
        .prepare(
          "SELECT COUNT(*) AS count FROM project_maintenance_attempts WHERE project_id=?",
        )
        .get("project-1") as { count: number };
      expect(count.count).toBeLessThanOrEqual(130);
      expect(listPendingMaintenanceReports()).toHaveLength(1);
      expect(listPendingMaintenanceReports()[0].observed_at).toBe(
        "2026-09-23T10:00:00.000Z",
      );
    } finally {
      closeDatabase();
      if (oldFilename == null) delete process.env.COCALC_LITE_SQLITE_FILENAME;
      else process.env.COCALC_LITE_SQLITE_FILENAME = oldFilename;
    }
  });

  it("keeps the newest report pending until that exact report is delivered", () => {
    const oldFilename = process.env.COCALC_LITE_SQLITE_FILENAME;
    process.env.COCALC_LITE_SQLITE_FILENAME = ":memory:";
    closeDatabase();
    try {
      const first = {
        project_id: "project-1",
        host_id: "host-1",
        kind: "backup" as const,
        observed_at: "2026-09-23T10:00:00.000Z",
        outcome: "failed" as const,
      };
      const second = {
        ...first,
        observed_at: "2026-09-23T10:05:00.000Z",
        outcome: "succeeded" as const,
      };
      saveMaintenanceReport(first);
      saveMaintenanceReport(second);
      markMaintenanceReportDelivered(first);
      expect(listPendingMaintenanceReports()).toEqual([second]);
      saveMaintenanceReport(first);
      expect(listPendingMaintenanceReports()).toEqual([second]);
      markMaintenanceReportDelivered(second);
      expect(listPendingMaintenanceReports()).toEqual([]);
    } finally {
      closeDatabase();
      if (oldFilename == null) delete process.env.COCALC_LITE_SQLITE_FILENAME;
      else process.env.COCALC_LITE_SQLITE_FILENAME = oldFilename;
    }
  });

  it("bounds cached schedules by a short lease and removes moved projects", () => {
    const oldFilename = process.env.COCALC_LITE_SQLITE_FILENAME;
    process.env.COCALC_LITE_SQLITE_FILENAME = ":memory:";
    closeDatabase();
    try {
      const first = {
        project_id: "project-1",
        last_edited: "2026-09-23T10:00:00.000Z",
        snapshots: { frequent: 1, daily: 1, weekly: 1, monthly: 1 },
        backups: { frequent: 0, daily: 0, weekly: 1, monthly: 1 },
      };
      const second = { ...first, project_id: "project-2" };
      const verifiedAtMs = Date.parse("2026-09-23T10:00:00.000Z");
      saveValidatedMaintenanceSchedules({
        hostId: "host-1",
        rows: [first, second],
        verifiedAtMs,
      });
      expect(
        listLeasedMaintenanceSchedules({
          hostId: "host-1",
          nowMs: verifiedAtMs + MAX_MAINTENANCE_OWNERSHIP_LEASE_MS,
        }),
      ).toEqual([first, second]);
      expect(
        listLeasedMaintenanceSchedules({
          hostId: "host-1",
          nowMs: verifiedAtMs + MAX_MAINTENANCE_OWNERSHIP_LEASE_MS + 1,
        }),
      ).toEqual([]);

      saveValidatedMaintenanceSchedules({
        hostId: "host-1",
        rows: [],
        requestedProjectIds: [first.project_id],
        verifiedAtMs: verifiedAtMs + 1,
      });
      expect(
        listLeasedMaintenanceSchedules({
          hostId: "host-1",
          nowMs: verifiedAtMs + 1,
        }),
      ).toEqual([second]);
      saveValidatedMaintenanceSchedules({
        hostId: "host-1",
        rows: [],
        verifiedAtMs: verifiedAtMs + 2,
      });
      expect(
        listLeasedMaintenanceSchedules({
          hostId: "host-1",
          nowMs: verifiedAtMs + 2,
        }),
      ).toEqual([]);
    } finally {
      closeDatabase();
      if (oldFilename == null) delete process.env.COCALC_LITE_SQLITE_FILENAME;
      else process.env.COCALC_LITE_SQLITE_FILENAME = oldFilename;
    }
  });

  it("reuses validated schedules after a host process restart", () => {
    const oldFilename = process.env.COCALC_LITE_SQLITE_FILENAME;
    const directory = mkdtempSync(join(tmpdir(), "maintenance-ledger-"));
    process.env.COCALC_LITE_SQLITE_FILENAME = join(directory, "host.sqlite");
    closeDatabase();
    try {
      const row = {
        project_id: "project-restart",
        last_edited: "2026-09-23T10:00:00.000Z",
        snapshots: { frequent: 1, daily: 1, weekly: 1, monthly: 1 },
        backups: { frequent: 0, daily: 0, weekly: 1, monthly: 1 },
      };
      const verifiedAtMs = Date.parse(row.last_edited);
      saveValidatedMaintenanceSchedules({
        hostId: "host-1",
        rows: [row],
        verifiedAtMs,
      });
      const report = {
        project_id: row.project_id,
        host_id: "host-1",
        kind: "snapshot" as const,
        observed_at: row.last_edited,
        outcome: "failed" as const,
      };
      saveMaintenanceReport(report);
      closeDatabase();
      expect(
        listLeasedMaintenanceSchedules({
          hostId: "host-1",
          nowMs: verifiedAtMs + 1,
        }),
      ).toEqual([row]);
      expect(listPendingMaintenanceReports()).toEqual([report]);
      expect(
        listRecentMaintenanceAttempts({ projectId: row.project_id }),
      ).toEqual([report]);
    } finally {
      closeDatabase();
      if (oldFilename == null) delete process.env.COCALC_LITE_SQLITE_FILENAME;
      else process.env.COCALC_LITE_SQLITE_FILENAME = oldFilename;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
