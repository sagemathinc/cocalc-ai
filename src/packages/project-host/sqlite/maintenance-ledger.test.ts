/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase } from "@cocalc/lite/hub/sqlite/database";
import {
  listLeasedMaintenanceSchedules,
  listPendingMaintenanceReports,
  MAX_MAINTENANCE_OWNERSHIP_LEASE_MS,
  markMaintenanceReportDelivered,
  saveMaintenanceReport,
  saveValidatedMaintenanceSchedules,
} from "./maintenance-ledger";

describe("project maintenance report ledger", () => {
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
      closeDatabase();
      expect(
        listLeasedMaintenanceSchedules({
          hostId: "host-1",
          nowMs: verifiedAtMs + 1,
        }),
      ).toEqual([row]);
    } finally {
      closeDatabase();
      if (oldFilename == null) delete process.env.COCALC_LITE_SQLITE_FILENAME;
      else process.env.COCALC_LITE_SQLITE_FILENAME = oldFilename;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
