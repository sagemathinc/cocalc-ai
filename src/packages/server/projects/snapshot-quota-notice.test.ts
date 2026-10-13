/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const query = jest.fn();
const eventGraph = jest.fn();
const eventIds = new Set<string>();
let rows: any[] = [];

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...args: unknown[]) => query(...args) }),
}));
jest.mock("@cocalc/database/postgres/notifications-core", () => ({
  createNotificationEventGraph: (...args: unknown[]) => eventGraph(...args),
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  getSingleBayInfo: () => ({ bay_id: "bay-1" }),
  resolveAccountHomeBay: () => Promise.resolve({ home_bay_id: "bay-1" }),
}));
jest.mock("@cocalc/server/hub/site-url", () => ({
  __esModule: true,
  default: (path: string) => Promise.resolve(`https://cocalc.test/${path}`),
}));
jest.mock("./maintenance-status", () => ({
  ensureProjectMaintenanceStatusTable: () => Promise.resolve(),
}));

import { runProjectSnapshotQuotaNoticeCheck } from "./snapshot-quota-notice";

const projectId = "00000000-0000-4000-8000-000000000001";
const ownerId = "00000000-0000-4000-8000-000000000002";
const collaboratorId = "00000000-0000-4000-8000-000000000003";
const viewerId = "00000000-0000-4000-8000-000000000004";

function pausedProject(latest_snapshot_at: string | null) {
  return {
    project_id: projectId,
    title: "Thesis",
    users: {
      [ownerId]: { group: "owner" },
      [collaboratorId]: { group: "collaborator" },
      [viewerId]: { group: "viewer" },
    },
    latest_snapshot_at,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  eventIds.clear();
  rows = [pausedProject("2026-10-01T00:00:00.000Z")];
  query.mockImplementation((sql: string, params: unknown[]) => {
    if (sql.includes("FROM notification_events")) {
      return Promise.resolve({
        rows: eventIds.has(`${params[0]}`) ? [{ event_id: params[0] }] : [],
      });
    }
    return Promise.resolve({ rows });
  });
  eventGraph.mockImplementation((input: { event_id: string }) => {
    eventIds.add(input.event_id);
    return Promise.resolve({});
  });
});

it("tells the owner and collaborators once that snapshots are paused by the quota", async () => {
  expect(await runProjectSnapshotQuotaNoticeCheck()).toEqual({
    projects: 1,
    notices_sent: 2,
    failures: 0,
  });
  const targets = eventGraph.mock.calls.map(
    ([input]) => input.targets[0].target_account_id,
  );
  expect(targets.sort()).toEqual([ownerId, collaboratorId].sort());
  const [input] = eventGraph.mock.calls[0];
  expect(input.payload_json).toMatchObject({
    title: "Automatic snapshots paused: Thesis",
    notice_type: "project_snapshots_paused_quota",
    severity: "warning",
    action_link: `/projects/${projectId}/settings#recovery`,
  });
  expect(input.payload_json.body_markdown).toContain("at its storage quota");
  expect(
    input.targets[0].dedupe_key.startsWith("project-snapshots-paused-quota:"),
  ).toBe(true);
  const [sql, params] = query.mock.calls.find(([sql]) =>
    `${sql}`.includes("project_maintenance_status"),
  )!;
  expect(sql).toContain("s.reason='storage_quota_exceeded'");
  expect(sql).toContain("s.consecutive_failures >= $2");
  expect(params).toEqual(["bay-1", 2, 1000]);

  // The next check in the same episode sends nothing.
  expect(await runProjectSnapshotQuotaNoticeCheck()).toMatchObject({
    notices_sent: 0,
  });
});

it("notifies again only after snapshots have resumed and stopped again", async () => {
  await runProjectSnapshotQuotaNoticeCheck();
  rows = [pausedProject("2026-10-05T00:00:00.000Z")];
  expect(await runProjectSnapshotQuotaNoticeCheck()).toMatchObject({
    notices_sent: 2,
  });
});

it("counts a failed delivery and still notifies the other recipients", async () => {
  eventGraph.mockRejectedValueOnce(new Error("unavailable"));
  expect(await runProjectSnapshotQuotaNoticeCheck()).toEqual({
    projects: 1,
    notices_sent: 1,
    failures: 1,
  });
});
