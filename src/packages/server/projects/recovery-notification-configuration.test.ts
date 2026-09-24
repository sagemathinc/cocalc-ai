/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { getProjectRecoveryNotificationConfiguration } from "./recovery-notification-configuration";

describe("project recovery notification readiness", () => {
  it("does not make a disabled notification feature a site health failure", () => {
    expect(
      getProjectRecoveryNotificationConfiguration({
        project_recovery_notifications_enabled: false,
        email_backend: "none",
      }),
    ).toMatchObject({ issues: [] });
  });

  it("flags missing operator and critical email before paging is enabled", () => {
    expect(
      getProjectRecoveryNotificationConfiguration({
        project_recovery_notifications_enabled: true,
        email_backend: "none",
      }),
    ).toMatchObject({
      issues: [
        "named on-call administrator is missing",
        "critical email backend is unavailable",
      ],
    });
    expect(
      getProjectRecoveryNotificationConfiguration({
        project_recovery_notifications_enabled: true,
        project_recovery_oncall_account_id: "admin-id",
        email_backend: "sendgrid",
        notification_email_critical_backend: "default",
      }),
    ).toMatchObject({
      oncallAccountId: "admin-id",
      criticalEmailBackend: "sendgrid",
      issues: [],
    });
  });

  it("reports invalid critical email configuration without crashing health", () => {
    expect(
      getProjectRecoveryNotificationConfiguration({
        project_recovery_notifications_enabled: true,
        project_recovery_oncall_account_id: "admin-id",
        email_backend: "sendgrid",
        notification_email_critical_backend: "invalid-backend",
      }),
    ).toMatchObject({
      issues: ["critical email backend configuration is invalid"],
    });
  });
});
