/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const query = jest.fn();
const mockArchiveProjectStorage = jest.fn();
const mockClaimProjectArchiveLifecycleJob = jest.fn();
const mockClaimRetainedProjectArchiveLifecycleJob = jest.fn();
const mockGetServerSettings = jest.fn();
const mockListRecoverableProjectArchiveLifecycleJobs = jest.fn();
const mockResolveProjectBayDirect = jest.fn();
const mockUpdateProjectArchiveLifecycleJob = jest.fn();
const mockCountRecentAutomaticArchives = jest.fn();
const mockCountRunningArchivesByHost = jest.fn();
const mockClaimAutomaticJob = jest.fn();
const mockListQueuedProjectArchiveLifecycleJobs = jest.fn();

const clientQuery = jest.fn();
const mockReleaseArchiveFreeze = jest.fn();
const mockAppendOutbox = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({
    query,
    connect: async () => ({ query: clientQuery, release: jest.fn() }),
  }),
  withSessionAdvisoryLock: jest.fn(),
}));
jest.mock("@cocalc/database/postgres/project-events-outbox", () => ({
  appendProjectOutboxEventForProject: (...args: any[]) =>
    mockAppendOutbox(...args),
}));
const mockAssertProjectNotRehoming = jest.fn();
jest.mock("@cocalc/database/postgres/project-rehome-fence", () => ({
  assertProjectNotRehoming: (...args: any[]) =>
    mockAssertProjectNotRehoming(...args),
}));
jest.mock("@cocalc/server/project-host/control", () => ({
  releaseProjectDataArchiveFreezeOnHost: (...args: any[]) =>
    mockReleaseArchiveFreeze(...args),
}));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: mockGetServerSettings,
}));
jest.mock("@cocalc/server/account/project-feed", () => ({
  publishProjectAccountFeedEventsBestEffort: jest.fn(),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBayDirect: mockResolveProjectBayDirect,
}));
jest.mock("./archive", () => ({
  archiveProjectStorage: mockArchiveProjectStorage,
  ProjectArchiveStorageError: class extends Error {},
  FinalArchiveBackupPendingError: class extends Error {},
}));
jest.mock("./archive-lifecycle-accounts", () => ({
  resolveArchiveLifecycleAccountStatuses: jest.fn(),
}));
jest.mock("./archive-lifecycle-db", () => ({
  claimProjectArchiveLifecycleJob: mockClaimProjectArchiveLifecycleJob,
  claimRetainedProjectArchiveLifecycleJob:
    mockClaimRetainedProjectArchiveLifecycleJob,
  countRecentAutomaticArchives: (...args: any[]) =>
    mockCountRecentAutomaticArchives(...args),
  countRunningArchivesByHost: (...args: any[]) =>
    mockCountRunningArchivesByHost(...args),
  createProjectArchiveLifecycleJob: jest.fn(),
  listQueuedProjectArchiveLifecycleJobs: (...args: any[]) =>
    mockListQueuedProjectArchiveLifecycleJobs(...args),
  listRecoverableProjectArchiveLifecycleJobs:
    mockListRecoverableProjectArchiveLifecycleJobs,
  updateProjectArchiveLifecycleJob: mockUpdateProjectArchiveLifecycleJob,
}));
jest.mock("./archive-lifecycle-schema", () => ({
  ensureProjectArchiveLifecycleSchema: jest.fn(),
}));

import {
  __test__,
  ARCHIVE_OVERSIZED_FILES_FAILURE,
  getProjectArchiveBlockedSummary,
  getProjectArchiveHostCoverage,
  projectArchiveBlockedHealth,
  projectArchiveHostCoverageHealth,
  reopenStuckProjectArchive,
  runProjectArchiveLifecycleOnce,
} from "./archive-lifecycle-maintenance";
import type { ProjectArchiveLifecycleConfig } from "./archive-lifecycle-types";
import {
  FinalArchiveBackupPendingError,
  ProjectArchiveStorageError,
} from "./archive";
import { PROJECT_ARCHIVE_POLICY_VERSION } from "./archive-lifecycle-types";

const config: ProjectArchiveLifecycleConfig = {
  enabled: true,
  reportOnly: true,
  freeAfterDays: 30,
  bannedAfterDays: 7,
  batchLimit: 1,
  globalPerHour: 10,
  perHostConcurrency: 1,
  canaryBays: [],
  canaryHosts: [],
};

describe("project archive lifecycle candidate selector", () => {
  beforeEach(() => {
    query.mockReset();
    __test__.resetCandidateCursor();
  });

  it("uses indexed independent sources and preserves cursor precision", async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          project_id: "11111111-1111-4111-8111-111111111111",
          candidate_order_at: new Date("2026-06-23T04:28:55.473Z"),
          candidate_cursor_at: "2026-06-23 04:28:55.473123",
        },
      ],
    });

    await __test__.listCandidateSnapshots({ config });

    const [sql, firstParams] = query.mock.calls[0];
    expect(sql).toContain("candidate_ids AS MATERIALIZED");
    expect(sql).toContain("p.users ?|");
    expect(sql).not.toContain("jsonb_object_keys");
    expect(firstParams.slice(3)).toEqual([null, null]);

    query.mockResolvedValueOnce({ rows: [] });
    await __test__.listCandidateSnapshots({ config });
    const secondParams = query.mock.calls[1][1];
    expect(secondParams.slice(3)).toEqual([
      "2026-06-23 04:28:55.473123",
      "11111111-1111-4111-8111-111111111111",
    ]);
  });
});

describe("project archive lifecycle recovery", () => {
  beforeEach(() => {
    query.mockReset();
    mockArchiveProjectStorage.mockReset();
    mockClaimProjectArchiveLifecycleJob.mockReset();
    mockClaimRetainedProjectArchiveLifecycleJob.mockReset();
    mockGetServerSettings.mockReset();
    mockListRecoverableProjectArchiveLifecycleJobs.mockReset();
    mockResolveProjectBayDirect.mockReset();
    mockUpdateProjectArchiveLifecycleJob.mockReset();
  });

  it("recovers a retained archiving claim when automatic selection is disabled", async () => {
    const job = {
      id: "66666666-6666-4666-8666-666666666666",
      project_id: "44444444-4444-4444-8444-444444444444",
      owning_bay_id: "bay-0",
      host_id: "33333333-3333-4333-8333-333333333333",
      reason: "free-inactive" as const,
      policy_version: -1,
      status: "failed" as const,
      report_only: false,
      attempts: 1,
      thresholds: { free_after_days: 999 },
      final_backup_id: null,
      backup_generation: null,
      backup_time: null,
    };
    mockGetServerSettings.mockResolvedValue({
      automatic_project_archiving_enabled: false,
    });
    mockListRecoverableProjectArchiveLifecycleJobs.mockResolvedValue([job]);
    mockClaimRetainedProjectArchiveLifecycleJob.mockResolvedValue(true);
    mockResolveProjectBayDirect.mockResolvedValue({
      bay_id: "bay-0",
      epoch: 4,
    });
    query.mockResolvedValue({
      rows: [
        {
          project_id: job.project_id,
          owning_bay_id: "bay-0",
          ownership_epoch: 4,
          host_id: job.host_id,
          host_status: "active",
          deleted: null,
          provisioned: true,
          deletion_protection: false,
          state: { state: "archiving" },
          users: {},
          created: "2026-01-01T00:00:00.000Z",
          last_edited: "2026-01-01T00:00:00.000Z",
          last_changed: "2026-01-01T00:00:00.000Z",
          last_changed_generation: 10,
          last_backup: "2026-01-02T00:00:00.000Z",
          last_backup_generation: 10,
          backup_repo_id: "55555555-5555-4555-8555-555555555555",
          archive_lifecycle_job_id: job.id,
          active_published_path: false,
        },
      ],
    });
    mockArchiveProjectStorage.mockResolvedValue(undefined);

    const result = await runProjectArchiveLifecycleOnce();

    expect(result.enabled).toBe(false);
    expect(result.completed).toBe(1);
    expect(mockArchiveProjectStorage).toHaveBeenCalledWith({
      final_backup_wait_ms: 8 * 60_000,
      project_id: job.project_id,
      mode: "automatic",
      job_id: job.id,
      reason: job.reason,
      expected_host_id: job.host_id,
    });
  });
});

describe("running archive jobs across hosts", () => {
  const job = (n: number, host_id: string) => ({
    id: `66666666-6666-4666-8666-00000000000${n}`,
    project_id: `44444444-4444-4444-8444-00000000000${n}`,
    owning_bay_id: "bay-0",
    host_id,
    reason: "free-inactive" as const,
    policy_version: -1,
    status: "failed" as const,
    report_only: false,
    attempts: 1,
    thresholds: {},
    final_backup_id: null,
    backup_generation: null,
    backup_time: null,
  });
  // each job's project is archiving under that job
  const archivingRow = (project_id: string, job_id: string) => ({
    project_id,
    owning_bay_id: "bay-0",
    host_id: "h",
    host_status: "active",
    deleted: null,
    provisioned: true,
    deletion_protection: false,
    state: { state: "archiving" },
    users: {},
    created: "2026-01-01T00:00:00.000Z",
    last_edited: "2026-01-01T00:00:00.000Z",
    archive_lifecycle_job_id: job_id,
    active_published_path: false,
  });

  let jobs: ReturnType<typeof job>[];
  beforeEach(() => {
    query.mockReset();
    mockArchiveProjectStorage.mockReset();
    mockClaimRetainedProjectArchiveLifecycleJob.mockReset();
    mockGetServerSettings.mockReset();
    mockListRecoverableProjectArchiveLifecycleJobs.mockReset();
    mockResolveProjectBayDirect.mockReset();
    mockUpdateProjectArchiveLifecycleJob.mockReset();
    mockGetServerSettings.mockResolvedValue({
      automatic_project_archiving_enabled: false,
    });
    mockClaimRetainedProjectArchiveLifecycleJob.mockResolvedValue(true);
    mockResolveProjectBayDirect.mockResolvedValue({
      bay_id: "bay-0",
      epoch: 1,
    });
    query.mockImplementation(async (_sql: string, params: any[]) => {
      const found = jobs.find(({ project_id }) => project_id === params?.[0]);
      return { rows: found ? [archivingRow(found.project_id, found.id)] : [] };
    });
  });

  it("runs jobs on different hosts at once, one per host, and doesn't let a slow one stall the rest", async () => {
    jobs = [
      job(1, "host-a"),
      job(2, "host-a"),
      job(3, "host-b"),
      job(4, "host-c"),
    ];
    mockListRecoverableProjectArchiveLifecycleJobs.mockResolvedValue(jobs);
    let running = 0;
    let maxRunning = 0;
    const perHost = new Map<string, number>();
    const finish: Array<() => void> = [];
    mockArchiveProjectStorage.mockImplementation(
      async ({ expected_host_id }: { expected_host_id: string }) => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        perHost.set(expected_host_id, (perHost.get(expected_host_id) ?? 0) + 1);
        expect(perHost.get(expected_host_id)).toBe(1);
        await new Promise<void>((resolve) => finish.push(resolve));
        perHost.set(expected_host_id, perHost.get(expected_host_id)! - 1);
        running -= 1;
      },
    );
    const pass = runProjectArchiveLifecycleOnce();
    // let the pool start its jobs: host-a once, host-b and host-c
    for (let i = 0; i < 20 && finish.length < 3; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(finish.length).toBe(3);
    // the bounded final-backup wait is passed to every job
    expect(mockArchiveProjectStorage).toHaveBeenCalledWith(
      expect.objectContaining({ final_backup_wait_ms: 8 * 60_000 }),
    );
    while (finish.length) {
      finish.shift()!();
      for (let i = 0; i < 10; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    const summary = await pass;
    expect(maxRunning).toBe(3);
    expect(summary.completed).toBe(4);
  });

  it("keeps a host busy for the rest of the pass while its final backup is pending", async () => {
    jobs = [job(1, "host-a"), job(2, "host-a"), job(3, "host-b")];
    mockListRecoverableProjectArchiveLifecycleJobs.mockResolvedValue(jobs);
    mockArchiveProjectStorage.mockImplementation(
      async ({ job_id }: { job_id: string }) => {
        if (job_id === jobs[0].id) {
          throw new (FinalArchiveBackupPendingError as any)("op-1");
        }
      },
    );
    const summary = await runProjectArchiveLifecycleOnce();
    expect(summary).toMatchObject({ pending: 1, completed: 1 });
    // the second host-a job did not start while host-a's backup runs
    expect(
      mockArchiveProjectStorage.mock.calls.map(([opts]) => opts.job_id),
    ).toEqual([jobs[0].id, jobs[2].id]);
  });

  it("counts a final backup still running as pending, without failing or reopening the job", async () => {
    jobs = [job(1, "host-a")];
    mockListRecoverableProjectArchiveLifecycleJobs.mockResolvedValue(jobs);
    mockArchiveProjectStorage.mockRejectedValue(
      new (FinalArchiveBackupPendingError as any)("op-1"),
    );
    const summary = await runProjectArchiveLifecycleOnce();
    expect(summary).toMatchObject({ pending: 1, failed: 0, completed: 0 });
    // archive.ts queued the job; the runner records no failure for it
    expect(mockUpdateProjectArchiveLifecycleJob).not.toHaveBeenCalled();
  });
});

describe("dispatching queued archive jobs", () => {
  const queuedJob = (n: number, host_id: string) => ({
    id: `66666666-6666-4666-8666-10000000000${n}`,
    project_id: `44444444-4444-4444-8444-10000000000${n}`,
    owning_bay_id: "bay-0",
    host_id,
    reason: "free-inactive" as const,
    policy_version: PROJECT_ARCHIVE_POLICY_VERSION,
    status: "queued" as const,
    report_only: false,
    attempts: 0,
    thresholds: {
      free_after_days: 30,
      banned_after_days: 7,
      canary_bays: [],
      canary_hosts: [],
    },
    final_backup_id: null,
    backup_generation: null,
    backup_time: null,
  });

  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
    mockGetServerSettings.mockReset();
    mockGetServerSettings.mockResolvedValue({
      automatic_project_archiving_enabled: true,
      automatic_project_archiving_report_only: false,
    });
    mockListRecoverableProjectArchiveLifecycleJobs.mockReset();
    mockListRecoverableProjectArchiveLifecycleJobs.mockResolvedValue([]);
    mockCountRecentAutomaticArchives.mockReset();
    mockCountRunningArchivesByHost.mockReset();
    mockClaimProjectArchiveLifecycleJob.mockReset();
    // claimed by someone else: the job then counts as stale, which shows
    // that it was dispatched
    mockClaimProjectArchiveLifecycleJob.mockResolvedValue(false);
  });

  it("goes on to other hosts when one host is busy", async () => {
    mockListQueuedProjectArchiveLifecycleJobs.mockResolvedValue([
      queuedJob(1, "host-busy"),
      queuedJob(2, "host-free"),
    ]);
    mockCountRecentAutomaticArchives.mockResolvedValue(0);
    mockCountRunningArchivesByHost.mockImplementation(async (host: string) =>
      host === "host-busy" ? 1 : 0,
    );
    const summary = await runProjectArchiveLifecycleOnce();
    expect(summary).toMatchObject({ rate_limited: 1, stale: 1 });
    expect(mockClaimProjectArchiveLifecycleJob).toHaveBeenCalledWith(
      queuedJob(2, "host-free").id,
    );
  });

  it("admits one job at a time, so concurrent workers can't exceed the hourly limit", async () => {
    mockGetServerSettings.mockResolvedValue({
      automatic_project_archiving_enabled: true,
      automatic_project_archiving_report_only: false,
      automatic_project_archiving_global_per_hour: 1,
    });
    mockListQueuedProjectArchiveLifecycleJobs.mockResolvedValue([
      queuedJob(1, "host-a"),
      queuedJob(2, "host-b"),
      queuedJob(3, "host-c"),
      queuedJob(4, "host-d"),
    ]);
    // a claim counts toward the hour, as claimed_at does in the database
    let claims = 0;
    mockCountRecentAutomaticArchives.mockImplementation(async () => claims);
    mockCountRunningArchivesByHost.mockResolvedValue(0);
    mockClaimProjectArchiveLifecycleJob.mockImplementation(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      claims += 1;
      return false;
    });
    await runProjectArchiveLifecycleOnce();
    expect(claims).toBe(1);
  });

  it("stops starting jobs at the global hourly limit", async () => {
    mockListQueuedProjectArchiveLifecycleJobs.mockResolvedValue([
      queuedJob(1, "host-a"),
      queuedJob(2, "host-b"),
      queuedJob(3, "host-c"),
      queuedJob(4, "host-d"),
      queuedJob(5, "host-e"),
    ]);
    mockCountRecentAutomaticArchives.mockResolvedValue(10_000);
    mockCountRunningArchivesByHost.mockResolvedValue(0);
    const summary = await runProjectArchiveLifecycleOnce();
    // each of the (at most 4) workers that started sees the limit and stops
    expect(summary.rate_limited).toBeLessThanOrEqual(4);
    expect(summary.rate_limited).toBeGreaterThan(0);
    expect(mockClaimProjectArchiveLifecycleJob).not.toHaveBeenCalled();
  });
});

describe("automatic archiving host coverage", () => {
  const LISTED = "11111111-1111-4111-8111-111111111111";
  beforeEach(() => {
    query.mockReset();
    mockGetServerSettings.mockReset();
  });

  function settings(overrides: Record<string, unknown> = {}) {
    mockGetServerSettings.mockResolvedValue({
      automatic_project_archiving_enabled: true,
      automatic_project_archiving_report_only: false,
      free_project_archive_after_days: 30,
      automatic_project_archiving_canary_hosts: `${LISTED}, not-a-uuid, ${LISTED.replace("1", "A")}`,
      ...overrides,
    });
  }

  it("lists shared hosts with projects on disk that the canary list leaves out", async () => {
    settings();
    query.mockResolvedValueOnce({
      rows: [
        {
          host_id: "22222222-2222-4222-8222-222222222222",
          name: "asia-3",
          status: "running",
          on_disk: "6039",
          idle: "3267",
        },
      ],
    });
    const coverage = await getProjectArchiveHostCoverage();
    const [sql, params] = query.mock.calls[0];
    // shared pool hosts only, bay-scoped, archived projects excluded
    expect(sql).toContain("h.tier IS NOT NULL");
    expect(sql).toContain("<> 'deprovisioned'");
    expect(sql).toContain("<> 'archived'");
    expect(sql).toContain("NOT (h.id::text = ANY($2::text[]))");
    // ids compared exactly, as the policy does: an uppercase id doesn't
    // match a host there either; a non-id entry is ignored, not an error
    expect(params).toEqual(["bay-0", [LISTED], 30]);
    expect(coverage).toEqual({
      applies: true,
      free_after_days: 30,
      missing: [
        {
          host_id: "22222222-2222-4222-8222-222222222222",
          name: "asia-3",
          status: "running",
          on_disk: 6039,
          idle: 3267,
        },
      ],
    });
    expect(projectArchiveHostCoverageHealth(coverage)).toEqual({
      level: "warning",
      summary:
        "1 shared host is missing from automatic_project_archiving_canary_hosts, so its idle projects are never archived automatically.",
      details: [
        "asia-3 (22222222-2222-4222-8222-222222222222, running): 6039 projects on disk, 3267 idle over 30 days",
      ],
    });
  });

  it("applies on a bay that the bay canary list includes", async () => {
    settings({ automatic_project_archiving_canary_bays: "bay-0,bay-other" });
    query.mockResolvedValueOnce({ rows: [] });
    const coverage = await getProjectArchiveHostCoverage();
    expect(coverage.applies).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("is healthy when every shared host is listed", async () => {
    settings();
    query.mockResolvedValueOnce({ rows: [] });
    expect(
      projectArchiveHostCoverageHealth(await getProjectArchiveHostCoverage())
        .level,
    ).toBe("healthy");
  });

  it.each([
    [
      // the list is kept (settings()), so only the reason tells them apart
      "automatic archiving is off, even with a list",
      { automatic_project_archiving_enabled: false },
      "archiving_disabled",
      "Automatic archiving is disabled, so there is no host coverage to check.",
    ],
    [
      "a bay canary list leaves this bay out",
      { automatic_project_archiving_canary_bays: "bay-other" },
      "bay_not_in_canary",
      "This bay is not in automatic_project_archiving_canary_bays, so automatic archiving does not run here.",
    ],
    [
      "there is no canary host list",
      { automatic_project_archiving_canary_hosts: "" },
      "no_canary_list",
      "Automatic archiving has no canary host list, so it covers every host.",
    ],
  ])("does not query when %s", async (_, overrides, reason, summary) => {
    settings(overrides);
    const coverage = await getProjectArchiveHostCoverage();
    expect(query).not.toHaveBeenCalled();
    expect(coverage).toMatchObject({ applies: false, not_applicable: reason });
    expect(projectArchiveHostCoverageHealth(coverage)).toEqual({
      level: "healthy",
      summary,
      details: [],
    });
  });
});

const OVERSIZED =
  "FinalAutomaticArchiveBackupError: final automatic archive backup failed: Error: Unable to archive this project: 1 file is larger than this project's 10 GB backup file size limit and would not be included (big.bin). Delete or shrink it, or confirm that it may be skipped.";

describe("automatic archives stopped by files over the backup limit", () => {
  const job = {
    id: "66666666-6666-4666-8666-666666666666",
    project_id: "44444444-4444-4444-8444-444444444444",
    owning_bay_id: "bay-0",
    host_id: "33333333-3333-4333-8333-333333333333",
    reason: "free-inactive" as const,
    policy_version: -1,
    status: "failed" as const,
    report_only: false,
    attempts: 790,
    thresholds: {},
    final_backup_id: null,
    backup_generation: null,
    backup_time: null,
  };
  const archivingProject = {
    project_id: job.project_id,
    owning_bay_id: "bay-0",
    host_id: job.host_id,
    host_status: "active",
    deleted: null,
    provisioned: true,
    deletion_protection: false,
    state: { state: "archiving" },
    users: {},
    created: "2026-01-01T00:00:00.000Z",
    last_edited: "2026-01-01T00:00:00.000Z",
    archive_lifecycle_job_id: job.id,
    active_published_path: false,
  };

  beforeEach(() => {
    query.mockReset();
    clientQuery.mockReset();
    clientQuery.mockResolvedValue({ rowCount: 1, rows: [] });
    mockArchiveProjectStorage.mockReset();
    mockClaimRetainedProjectArchiveLifecycleJob.mockReset();
    mockGetServerSettings.mockReset();
    mockListRecoverableProjectArchiveLifecycleJobs.mockReset();
    mockResolveProjectBayDirect.mockReset();
    mockUpdateProjectArchiveLifecycleJob.mockReset();
    mockReleaseArchiveFreeze.mockReset();
    mockGetServerSettings.mockResolvedValue({
      automatic_project_archiving_enabled: false,
    });
    mockListRecoverableProjectArchiveLifecycleJobs.mockResolvedValue([job]);
    mockClaimRetainedProjectArchiveLifecycleJob.mockResolvedValue(true);
    mockResolveProjectBayDirect.mockResolvedValue({
      bay_id: "bay-0",
      epoch: 4,
    });
    query.mockResolvedValue({ rows: [archivingProject] });
  });

  function failWith(message: string, reopenSafe: boolean) {
    mockArchiveProjectStorage.mockRejectedValue(
      Object.assign(new (ProjectArchiveStorageError as any)(message), {
        hostCleanupCompleted: false,
        reopenSafe,
      }),
    );
  }
  const reopened = () =>
    clientQuery.mock.calls.some(([sql]) =>
      `${sql}`.includes("UPDATE projects"),
    );

  it("stops retrying and keeps the project for an admin reopen when reopening isn't safe", async () => {
    failWith(OVERSIZED, false);
    await runProjectArchiveLifecycleOnce();
    expect(reopened()).toBe(false);
    expect(mockUpdateProjectArchiveLifecycleJob).toHaveBeenCalledWith(
      expect.objectContaining({
        job_id: job.id,
        status: "failed",
        failure_category: ARCHIVE_OVERSIZED_FILES_FAILURE,
      }),
    );
  });

  it("reopens the project and cancels the job when reopening is safe", async () => {
    failWith(OVERSIZED, true);
    await runProjectArchiveLifecycleOnce();
    expect(reopened()).toBe(true);
    expect(mockUpdateProjectArchiveLifecycleJob).toHaveBeenCalledWith(
      expect.objectContaining({
        job_id: job.id,
        status: "canceled",
        failure_category: ARCHIVE_OVERSIZED_FILES_FAILURE,
      }),
    );
  });

  it("(control) retries any other storage failure as before", async () => {
    failWith("final automatic archive backup failed: timeout", false);
    await runProjectArchiveLifecycleOnce();
    expect(mockUpdateProjectArchiveLifecycleJob).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        failure_category: "archive-storage",
      }),
    );
  });
});

describe("reopenStuckProjectArchive", () => {
  const PROJECT = "44444444-4444-4444-8444-444444444444";
  const ADMIN = "77777777-7777-4777-8777-777777777777";
  const reserved = {
    job_id: "66666666-6666-4666-8666-666666666666",
    host_id: "33333333-3333-4333-8333-333333333333",
    project_host_id: "33333333-3333-4333-8333-333333333333",
    previous_status: "failed",
    previous_failure_category: "oversized-files",
    backup_generation: "1234",
  };

  beforeEach(() => {
    query.mockReset();
    query.mockImplementation(async () => ({ rows: [], rowCount: 1 }));
    clientQuery.mockReset();
    clientQuery.mockImplementation(async () => ({ rowCount: 1, rows: [] }));
    mockReleaseArchiveFreeze.mockReset();
    mockAppendOutbox.mockReset();
    mockAssertProjectNotRehoming.mockReset();
    mockAssertProjectNotRehoming.mockResolvedValue(undefined);
  });

  const isReserve = (sql: unknown) => `${sql}`.includes("WITH target AS");
  const isFinalize = (sql: unknown) =>
    `${sql}`.includes("SET status = 'canceled'");
  // everything happens on the transaction's client
  function rows(
    reservation: any[],
    {
      runningBackups = 0,
      finalized = 1,
      projectUpdated = 1,
      rehome = [] as any[],
    } = {},
  ) {
    clientQuery.mockImplementation(async (sql: string) =>
      isReserve(sql)
        ? { rows: reservation }
        : `${sql}`.includes("long_running_operations")
          ? { rows: [{ count: `${runningBackups}` }] }
          : `${sql}`.includes("to_regclass")
            ? { rows: [{ present: rehome.length > 0 }] }
            : `${sql}`.includes("FROM project_rehome_operations")
              ? { rows: rehome }
              : isFinalize(sql)
                ? { rowCount: finalized, rows: [] }
                : `${sql}`.includes("UPDATE projects")
                  ? { rowCount: projectUpdated, rows: [] }
                  : { rowCount: 1, rows: [] },
    );
  }
  const reservationSql = () =>
    clientQuery.mock.calls.find(([sql]) => isReserve(sql));
  const statements = () =>
    clientQuery.mock.calls.map(([sql]) => `${sql}`.trim());
  // a refusal commits nothing: the reservation rolls back with the rest
  const expectRolledBack = () => {
    expect(statements()[0]).toBe("BEGIN");
    expect(statements()).toContain("ROLLBACK");
    expect(statements()).not.toContain("COMMIT");
    expect(query).not.toHaveBeenCalled();
  };
  const reopen = (reason = "owner asked; oversized file") =>
    reopenStuckProjectArchive({
      project_id: PROJECT,
      actor_account_id: ADMIN,
      reason,
    });

  it("reserves the job, then reopens and records who and why in one transaction", async () => {
    rows([reserved]);
    mockReleaseArchiveFreeze.mockResolvedValue({ status: "already-writable" });
    await expect(reopen()).resolves.toEqual({
      job_id: reserved.job_id,
      freeze_status: "already-writable",
    });
    // reserved atomically, never while running, automatic archives only
    const [sql, params] = reservationSql()!;
    expect(sql).toContain("job.status <> 'running'");
    expect(sql).toContain("FOR UPDATE OF job, p");
    expect(sql).toContain(
      "NOT (COALESCE(job.evidence, '{}'::jsonb) ? 'admin_reopen')",
    );
    expect(sql).toContain("job.reason <> 'manual'");
    // a lost attempt's reservation expires after its lease (15 min)
    expect(sql).toContain("make_interval(secs => $5::int)");
    // the job's age, which health reports, is left alone
    expect(sql).not.toMatch(/updated_at\s*=/);
    expect(params).toEqual([
      PROJECT,
      "bay-0",
      "admin-reopen",
      ADMIN,
      900,
      expect.any(String),
    ]);
    const token = params[5];
    // only the freeze of this job's final backup may be released
    expect(mockReleaseArchiveFreeze).toHaveBeenCalledWith({
      project_id: PROJECT,
      host_id: reserved.host_id,
      expected_generation: 1234,
    });
    const audit = clientQuery.mock.calls.find(([sql]) => isFinalize(sql));
    expect(audit?.[1]).toEqual([
      reserved.job_id,
      ADMIN,
      "owner asked; oversized file",
      "already-writable",
      "failed",
      "oversized-files",
      "admin-reopen",
      token,
    ]);
    // one transaction: reserve, then the job row (fenced on this attempt's
    // token), then the project
    const order = clientQuery.mock.calls.map(([sql]) =>
      isReserve(sql)
        ? "reserve"
        : isFinalize(sql)
          ? "job"
          : `${sql}`.includes("UPDATE projects")
            ? "project"
            : `${sql}`.trim(),
    );
    expect(
      order.filter(
        (step) =>
          !/to_regclass|project_rehome_operations|long_running_operations/.test(
            step,
          ),
      ),
    ).toEqual(["BEGIN", "reserve", "job", "project", "COMMIT"]);
    // the rehome fence covers the reservation and the host call: taken after
    // BEGIN, before reserving and releasing, and released only by COMMIT
    const at = (i: number) => clientQuery.mock.invocationCallOrder[i];
    const reserveAt = at(order.indexOf("reserve"));
    const fenceAt = mockAssertProjectNotRehoming.mock.invocationCallOrder[0];
    const releaseAt = mockReleaseArchiveFreeze.mock.invocationCallOrder[0];
    expect(at(0)).toBeLessThan(fenceAt);
    expect(fenceAt).toBeLessThan(reserveAt);
    expect(reserveAt).toBeLessThan(releaseAt);
    expect(releaseAt).toBeLessThan(at(order.length - 1));
    expect(mockAppendOutbox).toHaveBeenCalledTimes(1);
    // so does any freeze-capable backup with an unresolved uncertain outcome
    const [backupSql, backupParams] = clientQuery.mock.calls.find(([sql]) =>
      `${sql}`.includes("long_running_operations"),
    )!;
    expect(backupSql).toContain(
      "result ->> 'archive_freeze_recovery' = 'uncertain'",
    );
    // and one canceled or failed after it started, without a proven-safe
    // recovery
    expect(backupSql).toContain("started_at IS NOT NULL");
    expect(backupSql).toContain("NOT IN ('not-started', 'released')");
    expect(backupSql).not.toContain("created_at");
    expect(backupParams).toEqual([PROJECT]);
    // nothing outside the transaction
    expect(query).not.toHaveBeenCalled();
  });

  it("refuses without a reason, touching nothing", async () => {
    rows([reserved]);
    await expect(reopen("  ")).rejects.toThrow(/reason is required/);
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it("refuses when no job can be reserved (none, running, manual, or already being reopened)", async () => {
    rows([]);
    await expect(reopen()).rejects.toThrow(/refusing to reopen/);
    expect(mockReleaseArchiveFreeze).not.toHaveBeenCalled();
    expectRolledBack();
  });

  it.each([
    [
      "a backup runs",
      () => rows([reserved], { runningBackups: 1 }),
      /backup of this project is running/,
    ],
    [
      "the host can't release the freeze",
      () => {
        rows([reserved]);
        mockReleaseArchiveFreeze.mockRejectedValue(
          new Error(
            "refusing to release archive freeze at generation 99; expected 1234",
          ),
        );
      },
      /refusing to release/,
    ],
    [
      "the volume is gone from the host",
      () => {
        rows([reserved]);
        mockReleaseArchiveFreeze.mockResolvedValue({ status: "absent" });
      },
      /volume is absent/,
    ],
  ])(
    "rolls the reservation back and refuses when %s",
    async (_, setup, message) => {
      (setup as () => void)();
      await expect(reopen()).rejects.toThrow(message as RegExp);
      expect(reservationSql()).toBeDefined();
      expectRolledBack();
      expect(
        clientQuery.mock.calls.some(
          ([sql]) => isFinalize(sql) || `${sql}`.includes("UPDATE projects"),
        ),
      ).toBe(false);
    },
  );

  it("refuses while the project is being rehomed, and reopens only where it is still owned", async () => {
    rows([reserved]);
    mockReleaseArchiveFreeze.mockResolvedValue({ status: "released" });
    mockAssertProjectNotRehoming.mockRejectedValue(
      new Error("project rehome op-1 is running"),
    );
    await expect(reopen()).rejects.toThrow(/rehome op-1 is running/);
    // checked first in the reopen transaction: nothing reserved, host untouched
    expect(mockAssertProjectNotRehoming).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: PROJECT }),
    );
    expect(statements()).toEqual(["BEGIN", "ROLLBACK"]);
    expect(mockReleaseArchiveFreeze).not.toHaveBeenCalled();

    // and without a rehome, the project update requires this bay as owner
    clientQuery.mockClear();
    rows([reserved]);
    mockAssertProjectNotRehoming.mockResolvedValue(undefined);
    await reopen();
    const projectUpdate = clientQuery.mock.calls.find(([sql]) =>
      `${sql}`.includes("UPDATE projects"),
    )!;
    expect(projectUpdate[0]).toContain("COALESCE(owning_bay_id, $3) = $3");
    expect(projectUpdate[1]).toEqual([PROJECT, reserved.job_id, "bay-0"]);
  });

  it("refuses while a failed rehome could still be retried", async () => {
    rows([reserved], { rehome: [{ op_id: "op-7", status: "failed" }] });
    mockReleaseArchiveFreeze.mockResolvedValue({ status: "released" });
    await expect(reopen()).rejects.toThrow(/rehome op-7 is failed/);
    const rehomeQuery = clientQuery.mock.calls.find(([sql]) =>
      `${sql}`.includes("FROM project_rehome_operations"),
    )!;
    expect(rehomeQuery[0]).toContain("status IN ('running', 'failed')");
    expect(rehomeQuery[1]).toEqual([PROJECT]);
    // refused inside the fenced transaction, before reserving or the host
    expectRolledBack();
    expect(reservationSql()).toBeUndefined();
    expect(mockReleaseArchiveFreeze).not.toHaveBeenCalled();
  });

  it("commits nothing when its expired reservation was taken over by another attempt", async () => {
    // attempt B took over: the job no longer carries this attempt's token
    rows([reserved], { finalized: 0 });
    mockReleaseArchiveFreeze.mockResolvedValue({ status: "released" });
    await expect(reopen()).rejects.toThrow(/taken over/);
    expectRolledBack();
    // the project is never touched by the losing attempt
    expect(
      clientQuery.mock.calls.some(([sql]) =>
        `${sql}`.includes("UPDATE projects"),
      ),
    ).toBe(false);
    const [finalizeSql] = clientQuery.mock.calls.find(([sql]) =>
      isFinalize(sql),
    )!;
    expect(finalizeSql).toContain("->> 'token' = $8");
  });

  it("commits nothing if the project changed meanwhile", async () => {
    rows([reserved], { projectUpdated: 0 });
    mockReleaseArchiveFreeze.mockResolvedValue({ status: "released" });
    await expect(reopen()).rejects.toThrow(/changed meanwhile/);
    // rolled back: the reservation and the job's audit update with it
    expectRolledBack();
  });
});

describe("admin health for archives stopped by oversized files", () => {
  beforeEach(() => query.mockReset());

  it("lists stuck projects (no file names) apart from the count of reopened ones", async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          {
            project_id: "p-stuck",
            host_id: "h-1",
            since: new Date("2026-10-26T18:03:57Z"),
            total: "1",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ count: "3" }] });
    const summary = await getProjectArchiveBlockedSummary();
    const [stuckSql, stuckParams] = query.mock.calls[0];
    expect(stuckParams).toEqual([
      ARCHIVE_OVERSIZED_FILES_FAILURE,
      "bay-0",
      "admin-reopen",
    ]);
    // stuck projects only, so past reopens can't crowd them out
    expect(stuckSql).toContain("p.state ->> 'state' = 'archiving'");
    expect(stuckSql).toContain("COUNT(*) OVER ()");
    // a job reserved for an unfinished admin reopen is still stuck
    expect(stuckSql).toContain("->> 'previous_failure_category' = $1");
    const [reopenedSql, reopenedParams] = query.mock.calls[1];
    expect(reopenedSql).toContain("job.status = 'canceled'");
    expect(reopenedParams).toEqual([ARCHIVE_OVERSIZED_FILES_FAILURE, "bay-0"]);
    expect(summary).toMatchObject({ stuck_total: 1, reopened: 3 });
    expect(projectArchiveBlockedHealth(summary)).toEqual({
      level: "warning",
      summary:
        "1 project is stuck archiving because of files over the backup file size limit (an admin reopen is needed); 3 reopened automatically in the last 30 days (support may contact the owner).",
      details: [
        "Project p-stuck on h-1: archiving, stopped since 2026-10-26T18:03:57.000Z",
      ],
    });
  });

  it("is healthy with nothing stopped", () => {
    expect(
      projectArchiveBlockedHealth({ stuck: [], stuck_total: 0, reopened: 0 })
        .level,
    ).toBe("healthy");
  });
});
