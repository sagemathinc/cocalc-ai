/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { uuid } from "@cocalc/util/misc";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  confirmHostProjectMaintenanceAssignment,
  listHostProjectMaintenanceSchedules,
} from "./host-status";
import {
  ensureProjectMaintenanceStatusTable,
  recordProjectMaintenanceStatus,
} from "@cocalc/server/projects/maintenance-status";

describe("host recovery schedule ownership", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  afterAll(async () => {
    await getPool().end();
  });

  it("lists a busy project's success with its later change and no reconciliation", async () => {
    await ensureProjectMaintenanceStatusTable();
    const host_id = uuid();
    const project_id = uuid();
    const now = Date.now();
    const latest = new Date(now - 10 * 60_000);
    const changed = new Date(now - 2 * 60_000);
    await getPool().query(
      `INSERT INTO project_hosts (id, name, bay_id, created, updated)
       VALUES ($1, 'busy project host', $2, NOW(), NOW())`,
      [host_id, getConfiguredBayId()],
    );
    await getPool().query(
      `INSERT INTO projects
         (project_id, title, host_id, owning_bay_id, provisioned, last_edited)
       VALUES ($1, 'busy', $2, NULL, true, $3)`,
      [project_id, host_id, changed],
    );
    expect(
      await recordProjectMaintenanceStatus({
        host_id,
        project_id,
        kind: "snapshot",
        observed_at: new Date(now - 9 * 60_000).toISOString(),
        outcome: "succeeded",
        latest_snapshot_at: latest.toISOString(),
        due_at: new Date(latest.getTime() + 15 * 60_000).toISOString(),
        reconciled_change_at: changed.toISOString(),
        schedule_revision: "ignored-for-a-success",
      }),
    ).toBe(true);
    const [row] = await listHostProjectMaintenanceSchedules({
      host_id,
      project_ids: [project_id],
      limit: 1,
    });
    // What the host's snapshotDueAt reads (project-host's test feeds this
    // shape): the new snapshot, a later change, and no reconciliation.
    expect(row).toMatchObject({
      project_id,
      last_snapshot: latest.toISOString(),
      snapshot_reconciled_change_at: null,
    });
    expect(Date.parse(row.last_changed ?? row.last_edited ?? "")).toBe(
      changed.getTime(),
    );
  });

  it("serves only local and legacy projects to a local host", async () => {
    const bay_id = getConfiguredBayId();
    const foreign_bay_id = `${bay_id}-foreign`;
    const local_host_id = uuid();
    const foreign_host_id = uuid();
    const local_project_id = uuid();
    const legacy_project_id = uuid();
    const foreign_project_id = uuid();
    await getPool().query(
      `INSERT INTO project_hosts (id, name, bay_id, created, updated)
       VALUES ($1, 'recovery local host', $3, NOW(), NOW()),
              ($2, 'recovery foreign host', $4, NOW(), NOW())`,
      [local_host_id, foreign_host_id, bay_id, foreign_bay_id],
    );
    await getPool().query(
      `INSERT INTO projects
         (project_id, title, host_id, owning_bay_id, provisioned)
       VALUES ($1, 'local', $4, $5, true),
              ($2, 'legacy', $4, NULL, true),
              ($3, 'foreign shadow', $4, $6, true)`,
      [
        local_project_id,
        legacy_project_id,
        foreign_project_id,
        local_host_id,
        bay_id,
        foreign_bay_id,
      ],
    );
    const rows = await listHostProjectMaintenanceSchedules({
      host_id: local_host_id,
    });
    expect(rows.map(({ project_id }) => project_id).sort()).toEqual(
      [local_project_id, legacy_project_id].sort(),
    );
    expect(
      rows.map(({ storage_service_class }) => storage_service_class),
    ).toEqual(["unclassified", "unclassified"]);
    await expect(
      listHostProjectMaintenanceSchedules({ host_id: foreign_host_id }),
    ).rejects.toThrow("host not found");
    await getPool().query(
      `UPDATE projects SET owning_bay_id=$2 WHERE project_id=$1`,
      [local_project_id, foreign_bay_id],
    );
    await expect(
      confirmHostProjectMaintenanceAssignment({
        host_id: local_host_id,
        project_id: local_project_id,
        kind: "snapshot",
        schedule_revision: "irrelevant after ownership moved",
        observed_change_at: null,
      }),
    ).resolves.toEqual({ valid: false, reason: "assignment_changed" });
  });
});
