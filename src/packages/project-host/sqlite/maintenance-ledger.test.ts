/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { closeDatabase } from "@cocalc/lite/hub/sqlite/database";
import {
  listPendingMaintenanceReports,
  markMaintenanceReportDelivered,
  saveMaintenanceReport,
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
});
