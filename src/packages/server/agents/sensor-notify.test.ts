/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

const create = jest.fn(async (_input: any) => ({}));

jest.mock("@cocalc/database/postgres/notifications-core", () => ({
  createNotificationEventGraph: (input: any) => create(input),
  resolveNotificationTargetHomeBays: async ({
    account_ids,
  }: {
    account_ids: string[];
  }) => Object.fromEntries(account_ids.map((id) => [id, "home-bay"])),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "project-bay",
}));

import {
  notifySensorPaused,
  notifySensorPausedBestEffort,
} from "./sensor-notify";

const opts = {
  account_id: "00000000-0000-4000-8000-000000000001",
  project_id: "00000000-0000-4000-8000-000000000002",
  sensor_id: "00000000-0000-4000-8000-000000000003",
  revision: 4,
  title: "[Click me](https://evil.example) *now*",
  reason: "Paused after 5 failed runs in a row. Last error: <script>",
};

beforeEach(() => create.mockClear());

test("the approver gets one notice on their home bay, with plain text from the sensor", async () => {
  await notifySensorPaused(opts);
  const input = create.mock.calls[0][0];
  expect(input).toMatchObject({
    kind: "account_notice",
    source_bay_id: "project-bay",
    source_project_id: opts.project_id,
    origin_kind: "system",
  });
  expect(input.targets).toEqual([
    expect.objectContaining({
      target_account_id: opts.account_id,
      target_home_bay_id: "home-bay",
      dedupe_key: `agent-sensor-paused:${opts.sensor_id}:4`,
    }),
  ]);
  const summary = input.targets[0].summary_json;
  // Agent-written text cannot become a link or markup.
  expect(summary.title).toBe(
    "Sensor paused: \\[Click me\\]\\(https://evil.example\\) \\*now\\*",
  );
  expect(summary.body_markdown).toContain("Last error: \\<script\\>");
  expect(summary.action_link).toBe(`/projects/${opts.project_id}`);
});

test("a failure to notify never fails the run", async () => {
  create.mockRejectedValueOnce(new Error("outbox unavailable"));
  await expect(notifySensorPausedBestEffort(opts)).resolves.toBeUndefined();
});
