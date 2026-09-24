/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { ProjectRecoveryHealth } from "./maintenance-status";
import { buildProjectRecoveryNotificationPlan } from "./recovery-notification-plan";

function health(): ProjectRecoveryHealth {
  return {
    paying_snapshot_overdue: 0,
    paying_backup_overdue: 0,
    unclassified_snapshot_overdue: 0,
    unclassified_backup_overdue: 0,
    paying_snapshot_repeated_failures: 0,
    paying_backup_repeated_failures: 0,
    unknown_snapshot_status: 0,
    unknown_backup_status: 0,
    oldest_snapshot_delay_seconds: 0,
    oldest_backup_delay_seconds: 0,
    host_maintenance_blocks: [],
    by_host_class: [],
    oldest_debt: [],
  };
}

const checkedAt = "2026-09-24T12:00:00.000Z";

test("pages paying incident debt and failures without hiding affected projects", () => {
  const current = health();
  current.paying_snapshot_overdue = 2;
  current.paying_backup_repeated_failures = 1;
  current.oldest_debt = [
    {
      project_id: "project-paid",
      host_id: "host-1",
      storage_service_class: "paying",
      kind: "snapshot",
      due_at: "2026-09-24T09:00:00.000Z",
      delay_seconds: 10_800,
    },
  ];
  current.by_host_class = [
    {
      host_id: "host-1",
      storage_service_class: "paying",
      kind: "snapshot",
      overdue_count: 2,
      oldest_delay_seconds: 10_800,
      unknown_count: 0,
      repeated_failures: 0,
    },
    {
      host_id: "host-1",
      storage_service_class: "paying",
      kind: "backup",
      overdue_count: 0,
      oldest_delay_seconds: 0,
      unknown_count: 0,
      repeated_failures: 1,
    },
  ];

  const plan = buildProjectRecoveryNotificationPlan({
    bayId: "bay-1",
    checkedAt,
    health: current,
    recentPayingCompletions: [
      { host_id: "host-1", kind: "snapshot", succeeded: 1 },
    ],
    missingPressureHosts: [],
  });
  expect(plan.incidents.map(({ code }) => code)).toEqual([
    "paying_debt",
    "paying_failures",
  ]);
  expect(plan.incidents[0].body).toContain("project-paid");
  expect(plan.incidents[0].subject).toContain("host-1/snapshot");
  expect(plan.dailyReport).toContain("paying snapshot project project-paid");
});

test("alerts on an overdue paying queue with no completions, and clears after one", () => {
  const current = health();
  current.by_host_class = [
    {
      host_id: "host-1",
      storage_service_class: "paying",
      kind: "snapshot",
      overdue_count: 3,
      oldest_delay_seconds: 31 * 60,
      unknown_count: 0,
      repeated_failures: 0,
    },
    {
      host_id: "host-2",
      storage_service_class: "free",
      kind: "snapshot",
      overdue_count: 30,
      oldest_delay_seconds: 10 * 60 * 60,
      unknown_count: 0,
      repeated_failures: 0,
    },
  ];
  const input = {
    bayId: "bay-1",
    checkedAt,
    health: current,
    missingPressureHosts: [],
  };
  expect(
    buildProjectRecoveryNotificationPlan({
      ...input,
      recentPayingCompletions: [],
    }).incidents.map(({ code }) => code),
  ).toEqual(["paying_queue_stalled"]);
  expect(
    buildProjectRecoveryNotificationPlan({
      ...input,
      recentPayingCompletions: [
        {
          host_id: "host-1",
          kind: "snapshot",
          succeeded: 1,
        },
      ],
    }).incidents,
  ).toEqual([]);
});

test("missing pressure telemetry alerts while free debt stays in the daily report", () => {
  const current = health();
  current.by_host_class = [
    {
      host_id: "host-free",
      storage_service_class: "free",
      kind: "backup",
      overdue_count: 4,
      oldest_delay_seconds: 60 * 60,
      unknown_count: 0,
      repeated_failures: 0,
    },
  ];
  const plan = buildProjectRecoveryNotificationPlan({
    bayId: "bay-1",
    checkedAt,
    health: current,
    recentPayingCompletions: [],
    missingPressureHosts: ["host-no-telemetry"],
  });
  expect(plan.incidents.map(({ code }) => code)).toEqual([
    "pressure_telemetry_missing",
  ]);
  expect(plan.incidents[0].body).toContain("host-no-telemetry");
  expect(plan.dailyReport).toContain("host-free free backup");
});

test("escalates late debt whose storage payer is still unclassified", () => {
  const current = health();
  current.unclassified_backup_overdue = 1;
  current.by_host_class = [
    {
      host_id: "host-1",
      storage_service_class: "unclassified",
      kind: "backup",
      overdue_count: 1,
      oldest_delay_seconds: 13 * 60 * 60,
      unknown_count: 0,
      repeated_failures: 0,
    },
  ];
  current.oldest_debt = [
    {
      project_id: "project-unknown",
      host_id: "host-1",
      storage_service_class: "unclassified",
      kind: "backup",
      due_at: "2026-09-23T00:00:00.000Z",
      delay_seconds: 13 * 60 * 60,
    },
  ];
  const plan = buildProjectRecoveryNotificationPlan({
    bayId: "bay-1",
    checkedAt,
    health: current,
    recentPayingCompletions: [],
    missingPressureHosts: [],
  });
  expect(plan.incidents.map(({ code }) => code)).toEqual(["unclassified_debt"]);
  expect(plan.incidents[0].body).toContain("project-unknown");
});
