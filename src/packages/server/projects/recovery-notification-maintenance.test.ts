/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

const settings = jest.fn();
const admins = jest.fn();
const recoveryHealth = jest.fn();
const recentPayingCompletions = jest.fn();
const pressureWindows = jest.fn();
const sendMessage = jest.fn();

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: (...args: unknown[]) => settings(...args),
}));
jest.mock("@cocalc/server/accounts/admins", () => ({
  __esModule: true,
  default: (...args: unknown[]) => admins(...args),
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  getSingleBayInfo: () => ({ bay_id: "bay-1" }),
}));
jest.mock("@cocalc/server/projects/maintenance-status", () => ({
  getProjectRecoveryHealth: (...args: unknown[]) => recoveryHealth(...args),
  getProjectRecoveryRecentPayingCompletions: (...args: unknown[]) =>
    recentPayingCompletions(...args),
}));
jest.mock("@cocalc/database/postgres/project-host-metrics", () => ({
  getProjectHostStoragePressureWindows: (...args: unknown[]) =>
    pressureWindows(...args),
}));
jest.mock("@cocalc/server/messages/send", () => ({
  __esModule: true,
  default: (...args: unknown[]) => sendMessage(...args),
}));

const checkedAt = new Date("2026-09-24T12:00:00.000Z");

beforeEach(() => {
  jest.clearAllMocks();
  settings.mockResolvedValue({
    project_recovery_notifications_enabled: false,
    project_recovery_oncall_account_id: "admin-1",
  });
  admins.mockResolvedValue(["admin-1"]);
  recoveryHealth.mockResolvedValue({
    paying_snapshot_overdue: 0,
    paying_backup_overdue: 0,
    paying_snapshot_repeated_failures: 0,
    paying_backup_repeated_failures: 0,
    unknown_snapshot_status: 0,
    unknown_backup_status: 0,
    oldest_snapshot_delay_seconds: 0,
    oldest_backup_delay_seconds: 0,
    by_host_class: [],
    oldest_debt: [],
  });
  recentPayingCompletions.mockResolvedValue([]);
  pressureWindows.mockResolvedValue([]);
  sendMessage.mockResolvedValue(2);
});

test("disabled notifications do not query recovery data or send a message", async () => {
  const { runProjectRecoveryNotificationCheck } =
    await import("./recovery-notification-maintenance");
  expect(await runProjectRecoveryNotificationCheck({ checkedAt })).toEqual({
    enabled: false,
    incident_count: 0,
    daily_report_checked: false,
  });
  expect(recoveryHealth).not.toHaveBeenCalled();
  expect(sendMessage).not.toHaveBeenCalled();
});

test("enabled notifications send the named administrator paid incidents and a daily report", async () => {
  settings.mockResolvedValue({
    project_recovery_notifications_enabled: true,
    project_recovery_oncall_account_id: "admin-1",
  });
  recoveryHealth.mockResolvedValue({
    paying_snapshot_overdue: 1,
    paying_backup_overdue: 0,
    paying_snapshot_repeated_failures: 0,
    paying_backup_repeated_failures: 0,
    unknown_snapshot_status: 0,
    unknown_backup_status: 0,
    oldest_snapshot_delay_seconds: 3 * 60 * 60,
    oldest_backup_delay_seconds: 0,
    by_host_class: [],
    oldest_debt: [],
  });
  const { runProjectRecoveryNotificationCheck } =
    await import("./recovery-notification-maintenance");
  const result = await runProjectRecoveryNotificationCheck({ checkedAt });
  expect(result).toEqual({
    enabled: true,
    incident_count: 1,
    daily_report_checked: true,
  });
  expect(sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      subject: expect.stringContaining(
        "Admin Alert - Project recovery paying debt on bay-1",
      ),
      to_ids: ["admin-1"],
      requireAccountNoticeDelivery: true,
    }),
  );
  expect(sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      to_ids: ["admin-1"],
      subject: "Project recovery daily debt report: bay-1: 2026-09-24",
      requireAccountNoticeDelivery: true,
    }),
  );
  expect(
    await runProjectRecoveryNotificationCheck({ checkedAt }),
  ).toMatchObject({ daily_report_checked: false });
  expect(
    sendMessage.mock.calls.filter(([arg]) =>
      arg.subject.startsWith("Project recovery daily debt report:"),
    ),
  ).toHaveLength(1);
});

test("misconfigured recipient alerts site admins without sending project debt", async () => {
  settings.mockResolvedValue({
    project_recovery_notifications_enabled: true,
    project_recovery_oncall_account_id: "unknown-account",
  });
  const { runProjectRecoveryNotificationCheck } =
    await import("./recovery-notification-maintenance");
  await runProjectRecoveryNotificationCheck({ checkedAt });
  expect(sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      subject:
        "Admin Alert - Project recovery on-call configuration missing on bay-1",
      to_ids: ["admin-1"],
    }),
  );
  expect(recoveryHealth).not.toHaveBeenCalled();
});

test("an observation failure alerts the named on-call administrator", async () => {
  settings.mockResolvedValue({
    project_recovery_notifications_enabled: true,
    project_recovery_oncall_account_id: "admin-1",
  });
  recoveryHealth.mockRejectedValue(new Error("database unavailable"));
  const { runProjectRecoveryNotificationCheck } =
    await import("./recovery-notification-maintenance");
  await expect(
    runProjectRecoveryNotificationCheck({ checkedAt }),
  ).rejects.toThrow("database unavailable");
  expect(sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      subject:
        "Admin Alert - Project recovery observation unavailable on bay-1",
      to_ids: ["admin-1"],
      requireAccountNoticeDelivery: true,
    }),
  );
});
