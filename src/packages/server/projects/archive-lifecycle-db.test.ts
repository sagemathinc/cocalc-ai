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
  claimProjectArchiveLifecycleJob,
  claimRetainedProjectArchiveLifecycleJob,
  countRunningArchivesByHost,
  clearProjectArchiveLifecycleFinalBackup,
  createProjectArchiveLifecycleJob,
  failStuckManualArchiveJobs,
  claimManualArchiveJobForRecovery,
  findUnresolvedManualArchiveJob,
  listManualArchiveJobsToRecover,
  resumeManualArchiveJob,
  settleManualArchiveJob,
  getProjectArchiveLifecycleFinalBackup,
  MANUAL_ARCHIVE_HEARTBEAT_MS,
  STUCK_MANUAL_ARCHIVE_MS,
  touchRunningProjectArchiveLifecycleJob,
  listQueuedProjectArchiveLifecycleJobs,
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

  it("fails only manual archive jobs left running past the bound", async () => {
    query.mockResolvedValue({
      rows: [{ id: "77777777-7777-4777-8777-777777777777" }],
    });

    expect(await failStuckManualArchiveJobs()).toEqual([
      "77777777-7777-4777-8777-777777777777",
    ]);
    const [sql, parameters] = query.mock.calls[0];
    expect(sql).toContain("reason = 'manual'");
    expect(sql).toContain("status = 'running'");
    expect(sql).toContain("failure_category = 'stuck-manual-archive'");
    expect(sql).toContain("updated_at < NOW() - make_interval");
    expect(parameters[0]).toBe(30 * 60);
  });

  it("refreshes only a running job, well within the stuck bound", async () => {
    await touchRunningProjectArchiveLifecycleJob(
      "77777777-7777-4777-8777-777777777777",
    );
    const [sql, parameters] = query.mock.calls[0];
    expect(sql).toContain("SET updated_at = NOW()");
    expect(sql).toContain("status = 'running'");
    expect(parameters).toEqual(["77777777-7777-4777-8777-777777777777"]);
    // a live call refreshes its job several times before it could look stuck
    expect(
      STUCK_MANUAL_ARCHIVE_MS / MANUAL_ARCHIVE_HEARTBEAT_MS,
    ).toBeGreaterThanOrEqual(5);
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

  it("never overwrites a job an admin reopen has reserved or finished", async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    await updateProjectArchiveLifecycleJob({
      job_id: "job-1",
      status: "failed",
      failure_category: "archive-storage",
    });
    const [sql] = query.mock.calls.at(-1)!;
    expect(sql).toContain("COALESCE(failure_category, '') <> 'admin-reopen'");
    expect(sql).toContain(
      "NOT (COALESCE(evidence, '{}'::jsonb) ? 'admin_reopen')",
    );
  });

  it("neither lists nor claims terminal jobs or jobs reserved for an admin reopen", async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    await listQueuedProjectArchiveLifecycleJobs(10);
    await listRecoverableProjectArchiveLifecycleJobs(10);
    await claimProjectArchiveLifecycleJob("job-1");
    await claimRetainedProjectArchiveLifecycleJob("job-1");
    const statements = query.mock.calls.map(([sql]) => `${sql}`);
    expect(statements).toHaveLength(4);
    for (const sql of statements) {
      expect(sql).toMatch(
        /COALESCE\((job\.)?failure_category, ''\) NOT IN \('oversized-files', 'admin-reopen'\)/,
      );
    }
  });
});

describe("manual archive jobs that may hold a freeze", () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rows: [], rowCount: 1 });
  });

  it("finds the project's newest manual job that is running or holds an unresolved freeze", async () => {
    await findUnresolvedManualArchiveJob(project.project_id);
    const [sql, parameters] = query.mock.calls[0];
    expect(sql).toContain("reason = 'manual'");
    expect(sql).toContain("status = 'running'");
    expect(sql).toMatch(
      /status = 'failed'\s+AND \(final_backup_id IS NOT NULL\s+OR failure_category = ANY\(\$2::text\[\]\)\)/,
    );
    expect(sql).toContain("ORDER BY created_at DESC");
    expect(parameters[0]).toBe(project.project_id);
    expect(parameters[1]).toEqual([
      "stuck-manual-archive",
      "manual-archive-freeze-uncertain",
      "manual-archive-finalize-pending",
      "manual-archive-freeze-quarantined",
    ]);
  });

  it("resumes a job in place, keeping its id and its recorded final backup", async () => {
    expect(await resumeManualArchiveJob("j-1")).toBe(true);
    const [sql, parameters] = query.mock.calls[0];
    expect(sql).toContain("SET status = 'running'");
    expect(sql).toContain("WHERE id = $1");
    expect(sql).toContain("reason = 'manual'");
    expect(sql).not.toContain("final_backup_id");
    expect(sql).not.toContain("backup_generation");
    // a quarantined job is never resumed
    expect(sql).toContain("COALESCE(failure_category, '') <> $3");
    expect(parameters[0]).toBe("j-1");
    expect(parameters[2]).toBe("manual-archive-freeze-quarantined");
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await resumeManualArchiveJob("j-2")).toBe(false);
  });

  it("lists failed manual jobs to recover, never quarantined ones", async () => {
    await listManualArchiveJobsToRecover(5);
    const [sql, parameters] = query.mock.calls[0];
    expect(sql).toContain("reason = 'manual'");
    expect(sql).toContain("status = 'failed'");
    expect(sql).toMatch(
      /final_backup_id IS NOT NULL\s+OR failure_category = ANY\(\$1::text\[\]\)/,
    );
    expect(sql).toContain("COALESCE(failure_category, '') <> $2");
    expect(parameters).toEqual([
      [
        "stuck-manual-archive",
        "manual-archive-freeze-uncertain",
        "manual-archive-finalize-pending",
      ],
      "manual-archive-freeze-quarantined",
      5,
    ]);
  });

  it("claims a failed manual job atomically, on the attempts it saw", async () => {
    query.mockResolvedValueOnce({ rows: [{ attempts: 4 }], rowCount: 1 });
    expect(
      await claimManualArchiveJobForRecovery({ job_id: "j-1", attempts: 3 }),
    ).toBe(4);
    const [sql, parameters] = query.mock.calls[0];
    expect(sql).toContain("SET status = 'running'");
    expect(sql).toContain("attempts = COALESCE(attempts, 0) + 1");
    expect(sql).toContain("AND status = 'failed'");
    expect(sql).toContain("AND COALESCE(attempts, 0) = $2");
    expect(parameters).toEqual(["j-1", 3]);
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(
      await claimManualArchiveJobForRecovery({ job_id: "j-1", attempts: 3 }),
    ).toBeUndefined();
  });

  it("fences a recovery settle on its claim, so it can't land on a resumed job", async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(
      await settleManualArchiveJob({
        job_id: "j-1",
        status: "failed",
        failure_category: "manual-archive-freeze-released",
        clear_final_backup: true,
        claimed_attempts: 4,
      }),
    ).toBe(false);
    const [sql, parameters] = query.mock.calls[0];
    expect(sql).toContain(
      "ELSE status = 'running' AND COALESCE(attempts, 0) = $6::int",
    );
    expect(parameters[5]).toBe(4);
  });

  it("clears the recorded final backup only when asked to", async () => {
    await settleManualArchiveJob({
      job_id: "j-1",
      status: "failed",
      failure_category: "manual-archive-freeze-quarantined",
      clear_final_backup: false,
    });
    const [sql, parameters] = query.mock.calls[0];
    expect(sql).toContain(
      "final_backup_id = CASE WHEN $4::boolean THEN NULL ELSE final_backup_id END",
    );
    expect(sql).toContain("reason = 'manual'");
    expect(parameters.slice(0, 4)).toEqual([
      "j-1",
      "failed",
      "manual-archive-freeze-quarantined",
      false,
    ]);
  });
});
