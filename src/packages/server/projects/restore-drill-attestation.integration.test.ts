/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { uuid } from "@cocalc/util/misc";
import { ensureLroSchema } from "@cocalc/server/lro/lro-db";
import { PROJECT_RESTORE_DRILLS_SQL } from "@cocalc/server/conat/api/admin-db";
import {
  getProjectRestoreDrillHealth,
  recordRestoreDrillAttestation,
  summarizeProjectRestoreDrills,
} from "./restore-drill-attestation";

const bay_id = "bay-0";
const expected = "a".repeat(64);
const observed = "b".repeat(64);

async function seedRestore({
  remoteOnly = true,
  backup_repo_id = uuid(),
}: { remoteOnly?: boolean; backup_repo_id?: string } = {}) {
  const project_id = uuid();
  const op_id = uuid();
  const backup_id = "backup-marker";
  await getPool().query(
    `INSERT INTO projects
       (project_id, title, owning_bay_id, host_id, backup_repo_id)
     VALUES ($1, 'restore drill', $2, $3, $4)`,
    [project_id, bay_id, uuid(), backup_repo_id],
  );
  await getPool().query(
    `INSERT INTO long_running_operations
       (op_id, kind, scope_type, scope_id, status, input, result,
        finished_at, expires_at)
     VALUES ($1, 'project-restore', 'project', $2, 'succeeded', $3, $4,
             now(), now() + interval '7 days')`,
    [
      op_id,
      project_id,
      { id: backup_id, remote_only: remoteOnly },
      { remote_only: remoteOnly, duration_ms: 1234 },
    ],
  );
  return { project_id, op_id, backup_id, backup_repo_id };
}

describe("restore drill operator attestation", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
    await ensureLroSchema();
  }, 15000);

  afterAll(async () => {
    await getPool().end();
  });

  it("persists a matching digest and makes identical retries idempotent", async () => {
    const { project_id, op_id, backup_id } = await seedRestore();
    const recorded_by = uuid();
    const input = {
      op_id,
      expected_sha256: expected,
      observed_sha256: expected,
      recorded_by,
      reason: "staging marker readback",
      bay_id,
    };
    const first = await recordRestoreDrillAttestation(input);
    expect(first.created).toBe(true);
    expect(first.attestation).toMatchObject({
      project_id,
      backup_id,
      passed: true,
      recorded_by,
    });
    const second = await recordRestoreDrillAttestation(input);
    expect(second.created).toBe(false);
    await expect(
      recordRestoreDrillAttestation({ ...input, observed_sha256: observed }),
    ).rejects.toThrow("different immutable attestation");
    expect(
      (
        await getPool().query(
          "SELECT count(*)::int AS count FROM project_restore_drill_attestations WHERE op_id = $1",
          [op_id],
        )
      ).rows[0].count,
    ).toBe(1);
  });

  it("records a hash mismatch as a failed drill", async () => {
    const { op_id } = await seedRestore();
    const result = await recordRestoreDrillAttestation({
      op_id,
      expected_sha256: expected,
      observed_sha256: observed,
      recorded_by: uuid(),
      reason: "staging marker mismatch",
      bay_id,
    });
    expect(result.attestation.passed).toBe(false);
  });

  it("rejects restores that did not bypass the local cache", async () => {
    const { op_id } = await seedRestore({ remoteOnly: false });
    await expect(
      recordRestoreDrillAttestation({
        op_id,
        expected_sha256: expected,
        observed_sha256: expected,
        recorded_by: uuid(),
        reason: "invalid restore",
        bay_id,
      }),
    ).rejects.toThrow("not a successful remote-only project restore");
  });

  it("keeps the drill visible after its operation record is removed", async () => {
    const { op_id, project_id } = await seedRestore();
    await recordRestoreDrillAttestation({
      op_id,
      expected_sha256: expected,
      observed_sha256: expected,
      recorded_by: uuid(),
      reason: "retention test",
      bay_id,
    });
    await getPool().query(
      "DELETE FROM long_running_operations WHERE op_id = $1",
      [op_id],
    );
    const report = await getPool().query(PROJECT_RESTORE_DRILLS_SQL, [
      project_id,
      30 * 24 * 60 * 60,
    ]);
    expect(report.rows).toEqual([
      expect.objectContaining({
        op_id,
        project_id,
        status: "succeeded",
        attestation_passed: true,
        evidence_source: "operator_supplied",
      }),
    ]);
    await getPool().query(
      "UPDATE project_restore_drill_attestations SET restore_finished_at = now() - interval '31 days' WHERE op_id = $1",
      [op_id],
    );
    const outsideWindow = await getPool().query(PROJECT_RESTORE_DRILLS_SQL, [
      project_id,
      30 * 24 * 60 * 60,
    ]);
    expect(outsideWindow.rows).toEqual([]);
  });

  it("reports the latest drill on every active shard with a confirmed backup", async () => {
    const passing = await seedRestore();
    const failed = await seedRestore();
    const missing = await seedRestore();
    const stale = await seedRestore();
    for (const restore of [passing, failed, missing, stale]) {
      await getPool().query(
        "UPDATE projects SET provisioned = true, last_backup = now() WHERE project_id = $1",
        [restore.project_id],
      );
    }
    for (const [restore, digest] of [
      [passing, expected],
      [failed, observed],
      [stale, expected],
    ] as const) {
      await recordRestoreDrillAttestation({
        op_id: restore.op_id,
        expected_sha256: expected,
        observed_sha256: digest,
        recorded_by: uuid(),
        reason: "coverage test",
        bay_id,
      });
    }
    await getPool().query(
      "UPDATE project_restore_drill_attestations SET restore_finished_at = now() - interval '31 days' WHERE op_id = $1",
      [stale.op_id],
    );
    const shards = await getProjectRestoreDrillHealth(bay_id);
    expect(shards).toHaveLength(4);
    expect(
      shards.find((row) => row.backup_repo_id === missing.backup_repo_id),
    ).toMatchObject({ latest_passed: null, backed_up_projects: 1 });
    expect(summarizeProjectRestoreDrills(shards)).toMatchObject({
      level: "critical",
      current: 1,
      failed: 1,
      missing: 1,
      stale: 1,
    });
    const withoutFailure = shards.filter(
      (row) => row.backup_repo_id !== failed.backup_repo_id,
    );
    expect(summarizeProjectRestoreDrills(withoutFailure).level).toBe("warning");
    expect(
      summarizeProjectRestoreDrills(
        withoutFailure.filter(
          (row) => row.backup_repo_id === passing.backup_repo_id,
        ),
      ).level,
    ).toBe("healthy");
  });
});
