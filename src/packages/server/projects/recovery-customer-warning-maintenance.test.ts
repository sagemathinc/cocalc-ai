/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const settings = jest.fn();
const query = jest.fn();
const membership = jest.fn();
const eventGraph = jest.fn();
const accountHome = jest.fn();
const currentStatus = jest.fn();
const ensureTable = jest.fn();
const eventIds = new Set<string>();
let persistedScan: Record<string, unknown> | null = null;

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: () => settings(),
}));
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...args: unknown[]) => query(...args) }),
}));
jest.mock("@cocalc/database/postgres/notifications-core", () => ({
  createNotificationEventGraph: (...args: unknown[]) => eventGraph(...args),
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  getSingleBayInfo: () => ({ bay_id: "bay-1" }),
  resolveAccountHomeBay: (...args: unknown[]) => accountHome(...args),
}));
jest.mock("@cocalc/server/hub/site-url", () => ({
  __esModule: true,
  default: (path: string) =>
    Promise.resolve(`https://staging2.cocalc.dev/${path}`),
}));
jest.mock("@cocalc/server/membership/runtime-resolution", () => ({
  resolveRuntimeMembership: (...args: unknown[]) => membership(...args),
}));
jest.mock("./maintenance-status", () => ({
  ensureProjectMaintenanceStatusTable: () => ensureTable(),
  getProjectRecoveryStatusLocal: (...args: unknown[]) => currentStatus(...args),
  projectRecoveryDueAt: (changed: Date | null) =>
    changed?.toISOString() ?? null,
  snapshotScheduleRevision: () => "current",
}));

const projectId = "00000000-0000-4000-8000-000000000001";
const ownerId = "00000000-0000-4000-8000-000000000002";
const collaboratorId = "00000000-0000-4000-8000-000000000003";
const viewerId = "00000000-0000-4000-8000-000000000004";
const sponsorId = "00000000-0000-4000-8000-000000000005";
const due = "2026-09-24T12:00:00.000Z";
const checkedAt = new Date("2026-09-24T12:30:01.000Z");

beforeEach(() => {
  jest.clearAllMocks();
  eventIds.clear();
  persistedScan = null;
  settings.mockResolvedValue({
    project_recovery_customer_warnings_enabled: false,
  });
  membership.mockResolvedValue({
    source: "subscription",
    subscription_cost: 10,
  });
  currentStatus.mockResolvedValue({
    snapshot_due_at: due,
    backup_due_at: null,
  });
  accountHome.mockImplementation(({ account_id }: { account_id: string }) =>
    Promise.resolve({
      home_bay_id: account_id === collaboratorId ? "bay-2" : "bay-1",
    }),
  );
  eventGraph.mockImplementation((input: { event_id: string }) => {
    eventIds.add(input.event_id);
    return Promise.resolve({});
  });
  query.mockImplementation((sql: string, params: unknown[]) => {
    if (
      sql.includes(
        "CREATE TABLE IF NOT EXISTS project_recovery_customer_warning_scan_status",
      ) ||
      sql.includes("ALTER TABLE project_recovery_customer_warning_scan_status")
    ) {
      return Promise.resolve({ rows: [] });
    }
    if (
      sql.includes("INSERT INTO project_recovery_customer_warning_scan_status")
    ) {
      persistedScan = {
        bay_id: params[0],
        last_completed_at: params[1],
        scanned: params[2],
        notices_sent: params[3],
        failures: params[4],
        cursor_project_id: params[5],
        cycle_scanned: params[6],
        cycle_failures: params[7],
        last_full_scan_at: params[8],
        last_full_scan_scanned: params[9],
        last_full_scan_failures: params[10],
      };
      return Promise.resolve({ rows: [] });
    }
    if (sql.includes("FROM project_recovery_customer_warning_scan_status")) {
      return Promise.resolve({ rows: persistedScan ? [persistedScan] : [] });
    }
    if (sql.includes("FROM notification_events")) {
      return Promise.resolve({
        rows: eventIds.has(`${params[0]}`) ? [{}] : [],
      });
    }
    if (sql.includes("LEFT JOIN project_maintenance_status")) {
      return Promise.resolve({
        rows: [
          {
            project_id: projectId,
            last_changed: new Date(due),
            last_backup: null,
            snapshots: { disabled: false },
            backups: { disabled: true },
            snapshot_at: null,
            reconciled_change_at: null,
            reconciled_schedule_revision: null,
          },
        ],
      });
    }
    if (sql.includes("SELECT p.usage_account_id::text")) {
      return Promise.resolve({
        rows: [
          {
            usage_account_id: null,
            users: {
              [ownerId]: { group: "owner" },
              [collaboratorId]: { group: "collaborator" },
              [viewerId]: { group: "viewer" },
            },
          },
        ],
      });
    }
    throw Error(`unexpected query: ${sql}`);
  });
});

test("the disabled switch performs no inventory scan or delivery", async () => {
  const { runProjectRecoveryCustomerWarningCheck } =
    await import("./recovery-customer-warning-maintenance");
  expect(await runProjectRecoveryCustomerWarningCheck({ checkedAt })).toEqual({
    enabled: false,
    scanned: 0,
    notices_sent: 0,
    failures: 0,
  });
  expect(query).not.toHaveBeenCalled();
  expect(eventGraph).not.toHaveBeenCalled();
});

test("an overdue paid snapshot warns current owners and collaborators with a Recovery link", async () => {
  settings.mockResolvedValue({
    project_recovery_customer_warnings_enabled: true,
  });
  const { runProjectRecoveryCustomerWarningCheck } =
    await import("./recovery-customer-warning-maintenance");
  expect(await runProjectRecoveryCustomerWarningCheck({ checkedAt })).toEqual({
    enabled: true,
    scanned: 1,
    notices_sent: 2,
    failures: 0,
  });
  expect(membership).toHaveBeenCalledWith(ownerId);
  expect(eventGraph).toHaveBeenCalledTimes(2);
  expect(eventGraph).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "account_notice",
      source_bay_id: "bay-1",
      source_project_id: projectId,
      payload_json: expect.objectContaining({
        title: `Project recovery warning: snapshot: ${projectId}: ${due}`,
        body_markdown: expect.stringContaining(
          `https://staging2.cocalc.dev/projects/${projectId}/settings#recovery`,
        ),
        severity: "warning",
        action_link: `/projects/${projectId}/settings#recovery`,
      }),
      targets: [
        expect.objectContaining({
          target_account_id: ownerId,
          target_home_bay_id: "bay-1",
        }),
      ],
    }),
  );
  expect(eventGraph).toHaveBeenCalledWith(
    expect.objectContaining({
      targets: [
        expect.objectContaining({
          target_account_id: collaboratorId,
          target_home_bay_id: "bay-2",
        }),
      ],
    }),
  );
  const { renderNotificationEmailMarkdownText } =
    await import("@cocalc/server/notifications/email-format");
  expect(
    renderNotificationEmailMarkdownText(
      eventGraph.mock.calls[0][0].payload_json.body_markdown,
    ),
  ).toContain(
    `https://staging2.cocalc.dev/projects/${projectId}/settings#recovery`,
  );
  expect(
    eventGraph.mock.calls.some(([arg]) =>
      arg.targets.some((target) => target.target_account_id === viewerId),
    ),
  ).toBe(false);
  expect(await runProjectRecoveryCustomerWarningCheck({ checkedAt })).toEqual({
    enabled: true,
    scanned: 1,
    notices_sent: 0,
    failures: 0,
  });
  expect(eventGraph).toHaveBeenCalledTimes(2);
});

test("an external storage payer funds warnings without joining the project", async () => {
  settings.mockResolvedValue({
    project_recovery_customer_warnings_enabled: true,
  });
  const originalQuery = query.getMockImplementation()!;
  query.mockImplementation((sql: string, params: unknown[]) => {
    if (sql.includes("SELECT p.usage_account_id::text")) {
      return Promise.resolve({
        rows: [
          {
            usage_account_id: sponsorId,
            users: {
              [ownerId]: { group: "owner" },
              [collaboratorId]: { group: "collaborator" },
            },
          },
        ],
      });
    }
    return originalQuery(sql, params);
  });
  const { runProjectRecoveryCustomerWarningCheck } =
    await import("./recovery-customer-warning-maintenance");
  expect(await runProjectRecoveryCustomerWarningCheck({ checkedAt })).toEqual({
    enabled: true,
    scanned: 1,
    notices_sent: 2,
    failures: 0,
  });
  expect(membership).toHaveBeenCalledWith(sponsorId);
  expect(accountHome).not.toHaveBeenCalledWith(
    expect.objectContaining({ account_id: sponsorId }),
  );
});

test("the paid snapshot target must actually be exceeded", async () => {
  settings.mockResolvedValue({
    project_recovery_customer_warnings_enabled: true,
  });
  const { runProjectRecoveryCustomerWarningCheck } =
    await import("./recovery-customer-warning-maintenance");
  await runProjectRecoveryCustomerWarningCheck({
    checkedAt: new Date("2026-09-24T12:30:00.000Z"),
  });
  expect(membership).not.toHaveBeenCalled();
  expect(eventGraph).not.toHaveBeenCalled();
});

test("an off-host backup warning starts only after the six-hour target", async () => {
  settings.mockResolvedValue({
    project_recovery_customer_warnings_enabled: true,
  });
  const originalQuery = query.getMockImplementation()!;
  query.mockImplementation((sql: string, ...args: unknown[]) => {
    if (sql.includes("LEFT JOIN project_maintenance_status")) {
      return Promise.resolve({
        rows: [
          {
            project_id: projectId,
            last_changed: new Date(due),
            last_backup: null,
            snapshots: { disabled: true },
            backups: { disabled: false },
          },
        ],
      });
    }
    return originalQuery(sql, ...args);
  });
  currentStatus.mockResolvedValue({
    snapshot_due_at: null,
    backup_due_at: due,
  });
  const { runProjectRecoveryCustomerWarningCheck } =
    await import("./recovery-customer-warning-maintenance");
  await runProjectRecoveryCustomerWarningCheck({
    checkedAt: new Date("2026-09-24T18:00:00.000Z"),
  });
  expect(eventGraph).not.toHaveBeenCalled();
  await runProjectRecoveryCustomerWarningCheck({
    checkedAt: new Date("2026-09-24T18:00:01.000Z"),
  });
  expect(eventGraph).toHaveBeenCalledWith(
    expect.objectContaining({
      payload_json: expect.objectContaining({
        title: `Project recovery warning: backup: ${projectId}: ${due}`,
        body_markdown: expect.stringContaining("off-host backup"),
      }),
    }),
  );
});

test("free funding and newly confirmed recovery both suppress warnings", async () => {
  settings.mockResolvedValue({
    project_recovery_customer_warnings_enabled: true,
  });
  membership.mockResolvedValueOnce({ source: "free" });
  const { runProjectRecoveryCustomerWarningCheck } =
    await import("./recovery-customer-warning-maintenance");
  await runProjectRecoveryCustomerWarningCheck({ checkedAt });
  expect(eventGraph).not.toHaveBeenCalled();
  currentStatus.mockResolvedValueOnce({
    snapshot_due_at: null,
    backup_due_at: null,
  });
  await runProjectRecoveryCustomerWarningCheck({ checkedAt });
  expect(eventGraph).not.toHaveBeenCalled();
});

test("an ownership change before delivery suppresses the stale candidate", async () => {
  settings.mockResolvedValue({
    project_recovery_customer_warnings_enabled: true,
  });
  query.mockImplementation((sql: string) =>
    Promise.resolve({
      rows: sql.includes("LEFT JOIN project_maintenance_status")
        ? [
            {
              project_id: projectId,
              last_changed: new Date(due),
              snapshots: {},
              backups: { disabled: true },
            },
          ]
        : [],
    }),
  );
  const { runProjectRecoveryCustomerWarningCheck } =
    await import("./recovery-customer-warning-maintenance");
  await runProjectRecoveryCustomerWarningCheck({ checkedAt });
  expect(membership).not.toHaveBeenCalled();
  expect(eventGraph).not.toHaveBeenCalled();
});

test("overlapping workers treat an already committed notice as a duplicate", async () => {
  settings.mockResolvedValue({
    project_recovery_customer_warnings_enabled: true,
  });
  eventGraph.mockImplementation((input: { event_id: string }) => {
    eventIds.add(input.event_id);
    return Promise.reject({ code: "23505" });
  });
  const { runProjectRecoveryCustomerWarningCheck } =
    await import("./recovery-customer-warning-maintenance");
  expect(await runProjectRecoveryCustomerWarningCheck({ checkedAt })).toEqual({
    enabled: true,
    scanned: 1,
    notices_sent: 0,
    failures: 0,
  });
  expect(eventIds.size).toBe(2);
});

test("enabled scans persist a timestamp and operator health detects stale scans", async () => {
  settings.mockResolvedValue({
    project_recovery_customer_warnings_enabled: true,
  });
  const {
    runProjectRecoveryCustomerWarningCheck,
    getProjectRecoveryCustomerWarningScanStatus,
    projectRecoveryCustomerWarningScanProblem,
  } = await import("./recovery-customer-warning-maintenance");
  await runProjectRecoveryCustomerWarningCheck({ checkedAt });
  expect(query).toHaveBeenCalledWith(
    expect.stringContaining(
      "INSERT INTO project_recovery_customer_warning_scan_status",
    ),
    ["bay-1", checkedAt, 1, 2, 0, null, 0, 0, checkedAt, 1, 0],
  );
  const scan = {
    bay_id: "bay-1",
    last_completed_at: checkedAt,
    scanned: 1,
    notices_sent: 2,
    failures: 0,
    cursor_project_id: null,
    cycle_scanned: 0,
    cycle_failures: 0,
    last_full_scan_at: checkedAt,
    last_full_scan_scanned: 1,
    last_full_scan_failures: 0,
  };
  expect(await getProjectRecoveryCustomerWarningScanStatus("bay-1")).toEqual(
    scan,
  );
  expect(
    projectRecoveryCustomerWarningScanProblem({
      enabled: true,
      scan,
      checkedAt: new Date(checkedAt.getTime() + 14 * 60_000),
    }),
  ).toBeNull();
  expect(
    projectRecoveryCustomerWarningScanProblem({
      enabled: true,
      scan,
      checkedAt: new Date(checkedAt.getTime() + 16 * 60_000),
    }),
  ).toContain("stale");
  expect(
    projectRecoveryCustomerWarningScanProblem({
      enabled: true,
      scan: null,
      checkedAt,
    }),
  ).toContain("not completed");
});

test("delivery failures remain visible in scan status and operator health", async () => {
  settings.mockResolvedValue({
    project_recovery_customer_warnings_enabled: true,
  });
  accountHome.mockRejectedValueOnce(Error("remote account bay unavailable"));
  const {
    runProjectRecoveryCustomerWarningCheck,
    projectRecoveryCustomerWarningScanProblem,
  } = await import("./recovery-customer-warning-maintenance");
  expect(await runProjectRecoveryCustomerWarningCheck({ checkedAt })).toEqual({
    enabled: true,
    scanned: 1,
    notices_sent: 1,
    failures: 1,
  });
  expect(query).toHaveBeenCalledWith(
    expect.stringContaining(
      "INSERT INTO project_recovery_customer_warning_scan_status",
    ),
    ["bay-1", checkedAt, 1, 1, 1, null, 0, 0, checkedAt, 1, 1],
  );
  expect(
    projectRecoveryCustomerWarningScanProblem({
      enabled: true,
      scan: {
        bay_id: "bay-1",
        last_completed_at: checkedAt,
        scanned: 1,
        notices_sent: 1,
        failures: 1,
        cursor_project_id: null,
        cycle_scanned: 0,
        cycle_failures: 0,
        last_full_scan_at: checkedAt,
        last_full_scan_scanned: 1,
        last_full_scan_failures: 1,
      },
      checkedAt,
    }),
  ).toContain("classification or delivery failures");
});

test("a scan resumes beyond 5000 projects after the worker module restarts", async () => {
  settings.mockResolvedValue({
    project_recovery_customer_warnings_enabled: true,
  });
  const projects = Array.from({ length: 5001 }, (_, index) => ({
    project_id: `00000000-0000-4000-8000-${(index + 1)
      .toString(16)
      .padStart(12, "0")}`,
    last_changed: null,
    last_backup: null,
    snapshots: { disabled: true },
    backups: { disabled: true },
    snapshot_at: null,
    reconciled_change_at: null,
    reconciled_schedule_revision: null,
  }));
  const originalQuery = query.getMockImplementation()!;
  query.mockImplementation((sql: string, params: unknown[]) => {
    if (sql.includes("LEFT JOIN project_maintenance_status")) {
      const cursor = params[1] as string | null;
      const start = cursor
        ? projects.findIndex(({ project_id }) => project_id > cursor)
        : 0;
      return Promise.resolve({
        rows: start < 0 ? [] : projects.slice(start, start + Number(params[2])),
      });
    }
    return originalQuery(sql, params);
  });
  const first = await import("./recovery-customer-warning-maintenance");
  expect(
    await first.runProjectRecoveryCustomerWarningCheck({ checkedAt }),
  ).toEqual({
    enabled: true,
    scanned: 5000,
    notices_sent: 0,
    failures: 0,
  });
  expect(persistedScan).toMatchObject({
    cursor_project_id: projects[4999].project_id,
    cycle_scanned: 5000,
    last_full_scan_at: null,
  });
  expect(
    first.projectRecoveryCustomerWarningScanProblem({
      enabled: true,
      scan: (await first.getProjectRecoveryCustomerWarningScanStatus("bay-1"))!,
      checkedAt,
    }),
  ).toContain("has not completed a full inventory");

  jest.resetModules();
  const second = await import("./recovery-customer-warning-maintenance");
  const nextCheck = new Date(checkedAt.getTime() + 5 * 60_000);
  expect(
    await second.runProjectRecoveryCustomerWarningCheck({
      checkedAt: nextCheck,
    }),
  ).toEqual({ enabled: true, scanned: 1, notices_sent: 0, failures: 0 });
  expect(persistedScan).toMatchObject({
    cursor_project_id: null,
    cycle_scanned: 0,
    last_full_scan_at: nextCheck,
    last_full_scan_scanned: 5001,
  });
  expect(
    second.projectRecoveryCustomerWarningScanProblem({
      enabled: true,
      scan: (await second.getProjectRecoveryCustomerWarningScanStatus(
        "bay-1",
      ))!,
      checkedAt: nextCheck,
    }),
  ).toBeNull();
});
