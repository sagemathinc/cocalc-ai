/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Runs the notice query against the real schema (PGlite).

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { uuid } from "@cocalc/util/misc";

jest.mock("@cocalc/server/bay-directory", () => ({
  ...jest.requireActual("@cocalc/server/bay-directory"),
  resolveAccountHomeBay: async () => ({
    home_bay_id: jest
      .requireActual("@cocalc/server/bay-directory")
      .getSingleBayInfo().bay_id,
  }),
}));
jest.mock("@cocalc/server/hub/site-url", () => ({
  __esModule: true,
  default: (path: string) => Promise.resolve(`https://cocalc.test/${path}`),
}));

import { getSingleBayInfo } from "@cocalc/server/bay-directory";
import { ensureProjectMaintenanceStatusTable } from "./maintenance-status";
import { runProjectSnapshotQuotaNoticeCheck } from "./snapshot-quota-notice";

describe("snapshot quota notice (database)", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
    await ensureProjectMaintenanceStatusTable();
  }, 15000);

  afterAll(async () => {
    await getPool().end();
  });

  async function pausedProject({
    latest_snapshot_at,
  }: {
    latest_snapshot_at: Date | null;
  }) {
    const project_id = uuid();
    const host_id = uuid();
    const owner = uuid();
    await getPool().query(
      `INSERT INTO projects
         (project_id, title, owning_bay_id, host_id, provisioned, users)
       VALUES ($1, 'Thesis', $2, $3, true, $4)`,
      [
        project_id,
        getSingleBayInfo().bay_id,
        host_id,
        { [owner]: { group: "owner" } },
      ],
    );
    await getPool().query(
      `INSERT INTO project_maintenance_status
         (project_id, kind, host_id, observed_at, outcome, reason,
          consecutive_failures, latest_snapshot_at)
       VALUES ($1, 'snapshot', $2, NOW(), 'failed', 'storage_quota_exceeded',
               3, $3)`,
      [project_id, host_id, latest_snapshot_at],
    );
    return { project_id, host_id };
  }

  async function notices(project_id: string): Promise<number> {
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM notification_events
        WHERE source_project_id=$1
          AND payload_json->>'notice_type'='project_snapshots_paused_quota'`,
      [project_id],
    );
    return rows[0].n;
  }

  it("notifies once per episode, also across a host move", async () => {
    const { project_id } = await pausedProject({
      latest_snapshot_at: new Date(Date.now() - 3 * 86_400_000),
    });

    await runProjectSnapshotQuotaNoticeCheck();
    expect(await notices(project_id)).toBe(1);

    // Already notified: the project is no longer selected at all.
    const again = await runProjectSnapshotQuotaNoticeCheck();
    expect(again.notices_sent).toBe(0);
    expect(await notices(project_id)).toBe(1);

    // A host move clears latest_snapshot_at while still blocked.
    await getPool().query(
      `UPDATE project_maintenance_status
          SET host_id=gen_random_uuid(), latest_snapshot_at=NULL
        WHERE project_id=$1`,
      [project_id],
    );
    await getPool().query(
      `UPDATE projects SET host_id=(
         SELECT host_id FROM project_maintenance_status WHERE project_id=$1)
        WHERE project_id=$1`,
      [project_id],
    );
    await runProjectSnapshotQuotaNoticeCheck();
    expect(await notices(project_id)).toBe(1);

    // A later successful snapshot starts a new episode.
    await getPool().query(
      `UPDATE project_maintenance_status
          SET latest_snapshot_at=NOW() + INTERVAL '1 second'
        WHERE project_id=$1`,
      [project_id],
    );
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await runProjectSnapshotQuotaNoticeCheck();
    expect(await notices(project_id)).toBe(2);
  });
});
