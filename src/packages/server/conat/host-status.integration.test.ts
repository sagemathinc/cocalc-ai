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

describe("host recovery schedule ownership", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  afterAll(async () => {
    await getPool().end();
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
