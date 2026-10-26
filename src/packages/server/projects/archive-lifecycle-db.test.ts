/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const query = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query }),
}));

jest.mock("./archive-lifecycle-schema", () => ({
  ensureProjectArchiveLifecycleSchema: jest.fn(async () => undefined),
  PROJECT_ARCHIVE_LIFECYCLE_TABLE: "project_archive_lifecycle_jobs",
}));

import {
  claimRetainedProjectArchiveLifecycleJob,
  countRunningArchivesByHost,
  clearProjectArchiveLifecycleFinalBackup,
  createProjectArchiveLifecycleJob,
  getProjectArchiveLifecycleFinalBackup,
  listRecoverableProjectArchiveLifecycleJobs,
  recordProjectArchiveLifecycleFinalBackup,
  updateProjectArchiveLifecycleJob,
} from "./archive-lifecycle-db";
import type { ArchiveLifecycleProjectSnapshot } from "./archive-lifecycle-types";

const project: ArchiveLifecycleProjectSnapshot = {
  project_id: "44444444-4444-4444-8444-444444444444",
  owning_bay_id: "bay-1",
  host_id: "33333333-3333-4333-8333-333333333333",
  host_status: "active",
  deleted: null,
  provisioned: true,
  deletion_protection: false,
  state: { state: "opened" },
  users: {},
  created: "2026-01-01T00:00:00.000Z",
  last_edited: "2026-07-01T00:00:00.000Z",
  last_changed: "2026-07-01T00:00:00.000Z",
  last_changed_generation: 10,
  last_backup: "2026-07-02T00:00:00.000Z",
  last_backup_generation: 10,
  backup_repo_id: "55555555-5555-4555-8555-555555555555",
  archive_lifecycle_job_id: null,
  active_published_path: false,
};

describe("project archive lifecycle job persistence", () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
  });

  it("casts the shared status parameter consistently", async () => {
    await createProjectArchiveLifecycleJob({
      project,
      reason: "free-inactive",
      reportOnly: true,
    });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, parameters] = query.mock.calls[0];
    expect(sql).toContain("$7::VARCHAR(32)");
    expect(sql.match(/\$7::VARCHAR\(32\)/g)).toHaveLength(2);
    expect(sql).not.toMatch(/\$7(?!::VARCHAR\(32\))/);
    expect(parameters[6]).toBe("report-only");
  });

  it("casts every terminal status parameter reference consistently", async () => {
    await updateProjectArchiveLifecycleJob({
      job_id: "66666666-6666-4666-8666-666666666666",
      status: "completed",
    });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, parameters] = query.mock.calls[0];
    expect(sql.match(/\$2::VARCHAR\(32\)/g)).toHaveLength(3);
    expect(sql).not.toMatch(/\$2(?!::VARCHAR\(32\))/);
    expect(parameters[1]).toBe("completed");
  });

  it("persists the validated final backup before host cleanup", async () => {
    query.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await recordProjectArchiveLifecycleFinalBackup({
      job_id: "66666666-6666-4666-8666-666666666666",
      backup_id: "final-backup-id",
      backup_generation: 42,
      backup_time: "2026-08-28T04:00:00.000Z",
      expected_previous_backup_id: null,
    });

    const [sql, parameters] = query.mock.calls[0];
    expect(sql).toContain("final_backup_id = $2");
    expect(sql).toContain("status = 'running'");
    expect(sql).toContain("final_backup_id IS NOT DISTINCT FROM $5");
    expect(parameters).toEqual([
      "66666666-6666-4666-8666-666666666666",
      "final-backup-id",
      42,
      "2026-08-28T04:00:00.000Z",
      null,
    ]);
  });

  it("loads a durable final backup marker for cleanup retries", async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          final_backup_id: "final-backup-id",
          backup_generation: "42",
          backup_time: new Date("2026-08-28T04:00:00.000Z"),
        },
      ],
    });

    await expect(
      getProjectArchiveLifecycleFinalBackup(
        "66666666-6666-4666-8666-666666666666",
      ),
    ).resolves.toEqual({
      id: "final-backup-id",
      generation: "42",
      time: new Date("2026-08-28T04:00:00.000Z"),
    });
  });

  it("clears a final backup marker with a generation compare-and-set", async () => {
    query.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await clearProjectArchiveLifecycleFinalBackup({
      job_id: "66666666-6666-4666-8666-666666666666",
      backup_id: "final-backup-id",
      backup_generation: 42,
    });

    const [sql, parameters] = query.mock.calls[0];
    expect(sql).toContain("final_backup_id = NULL");
    expect(sql).toContain("final_backup_id = $2");
    expect(sql).toContain("backup_generation = $3");
    expect(parameters).toEqual([
      "66666666-6666-4666-8666-666666666666",
      "final-backup-id",
      42,
    ]);
  });

  it("selects only retained archiving claims for policy-independent recovery", async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await listRecoverableProjectArchiveLifecycleJobs(25);

    const [sql, parameters] = query.mock.calls[0];
    expect(sql).toContain("project.archive_lifecycle_job_id = job.id");
    expect(sql).toContain("project.state ->> 'state' = 'archiving'");
    expect(sql).toContain("job.status = 'failed'");
    expect(sql).toContain("job.status = 'running'");
    expect(sql).toContain(
      "job.status IN ('queued', 'stale', 'canceled', 'completed')",
    );
    expect(parameters).toEqual([25]);
  });

  it("claims retained project state independently of the old job status", async () => {
    query.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await expect(
      claimRetainedProjectArchiveLifecycleJob(
        "66666666-6666-4666-8666-666666666666",
      ),
    ).resolves.toBe(true);

    const [sql, parameters] = query.mock.calls[0];
    expect(sql).toContain("project.archive_lifecycle_job_id = job.id");
    expect(sql).toContain("project.state ->> 'state' = 'archiving'");
    expect(sql).toContain(
      "job.status IN ('queued', 'stale', 'canceled', 'completed')",
    );
    expect(parameters).toEqual(["66666666-6666-4666-8666-666666666666"]);
  });

  it("counts an archive whose final backup is pending as running on its host", async () => {
    query.mockResolvedValue({ rows: [{ count: "1" }] });
    await expect(countRunningArchivesByHost("host-1")).resolves.toBe(1);
    const [sql, params] = query.mock.calls.at(-1)!;
    expect(params).toEqual(["host-1"]);
    expect(sql).toContain("job.status = 'running'");
    expect(sql).toContain("job.status = 'queued'");
    expect(sql).toContain("p.state ->> 'state' = 'archiving'");
  });

  it("keeps the first claim time when resuming, so the hourly limit counts an archive once", async () => {
    query.mockResolvedValue({ rows: [], rowCount: 1 });
    await claimRetainedProjectArchiveLifecycleJob("job-1");
    expect(query.mock.calls.at(-1)![0]).toContain(
      "claimed_at = COALESCE(job.claimed_at, NOW())",
    );
  });
});
