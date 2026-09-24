/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const settings = jest.fn();
const query = jest.fn();
const membership = jest.fn();
const sendMessage = jest.fn();
const currentStatus = jest.fn();
const ensureTable = jest.fn();

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: () => settings(),
}));
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...args: unknown[]) => query(...args) }),
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  getSingleBayInfo: () => ({ bay_id: "bay-1" }),
}));
jest.mock("@cocalc/server/membership/resolve", () => ({
  resolveMembershipForAccount: (...args: unknown[]) => membership(...args),
}));
jest.mock("@cocalc/server/messages/send", () => ({
  __esModule: true,
  default: (...args: unknown[]) => sendMessage(...args),
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
const due = "2026-09-24T12:00:00.000Z";
const checkedAt = new Date("2026-09-24T12:30:01.000Z");

beforeEach(() => {
  jest.clearAllMocks();
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
  sendMessage.mockResolvedValue(1);
  query.mockImplementation((sql: string) => {
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
    notices_checked: 0,
  });
  expect(query).not.toHaveBeenCalled();
  expect(sendMessage).not.toHaveBeenCalled();
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
    notices_checked: 2,
  });
  expect(membership).toHaveBeenCalledWith(ownerId);
  expect(sendMessage).toHaveBeenCalledTimes(2);
  expect(sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      to_ids: [ownerId],
      subject: `Project recovery warning: snapshot: ${projectId}: ${due}`,
      body: expect.stringContaining(`/projects/${projectId}/settings#recovery`),
      dedupMinutes: 30 * 24 * 60,
      dedupBySubject: true,
      requireAccountNoticeDelivery: true,
    }),
  );
  expect(sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ to_ids: [collaboratorId] }),
  );
  expect(sendMessage).not.toHaveBeenCalledWith(
    expect.objectContaining({ to_ids: [viewerId] }),
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
  expect(sendMessage).not.toHaveBeenCalled();
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
  expect(sendMessage).not.toHaveBeenCalled();
  await runProjectRecoveryCustomerWarningCheck({
    checkedAt: new Date("2026-09-24T18:00:01.000Z"),
  });
  expect(sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      subject: `Project recovery warning: backup: ${projectId}: ${due}`,
      body: expect.stringContaining("off-host backup"),
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
  expect(sendMessage).not.toHaveBeenCalled();
  currentStatus.mockResolvedValueOnce({
    snapshot_due_at: null,
    backup_due_at: null,
  });
  await runProjectRecoveryCustomerWarningCheck({ checkedAt });
  expect(sendMessage).not.toHaveBeenCalled();
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
  expect(sendMessage).not.toHaveBeenCalled();
});
