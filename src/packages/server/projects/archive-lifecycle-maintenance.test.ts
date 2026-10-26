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

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query }),
  withSessionAdvisoryLock: jest.fn(),
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
  getProjectArchiveHostCoverage,
  projectArchiveHostCoverageHealth,
  runProjectArchiveLifecycleOnce,
} from "./archive-lifecycle-maintenance";
import type { ProjectArchiveLifecycleConfig } from "./archive-lifecycle-types";
import { FinalArchiveBackupPendingError } from "./archive";
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
      "automatic archiving is off",
      { automatic_project_archiving_enabled: false },
    ],
    [
      "there is no canary host list",
      { automatic_project_archiving_canary_hosts: "" },
    ],
  ])("does not query when %s", async (_, overrides) => {
    settings(overrides);
    const coverage = await getProjectArchiveHostCoverage();
    expect(query).not.toHaveBeenCalled();
    expect(coverage.applies).toBe(false);
    expect(projectArchiveHostCoverageHealth(coverage).level).toBe("healthy");
  });
});
