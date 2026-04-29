/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

jest.mock("antd", () => ({
  Alert: () => null,
  Button: () => null,
  Empty: () => null,
  Modal: () => null,
  Segmented: () => null,
  Space: ({ children }: any) => children,
  Spin: () => null,
  Tag: ({ children }: any) => children,
  Typography: { Text: ({ children }: any) => children },
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        purchases: {
          getManagedEgressHistory: jest.fn(),
          getManagedEgressAdminHistory: jest.fn(),
        },
      },
    },
  },
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  Tooltip: ({ children }: any) => children,
}));

jest.mock("@cocalc/frontend/components/error", () => () => null);

jest.mock("./managed-egress-recent-events", () => ({
  ManagedEgressRecentEventsList: () => null,
  formatManagedEgressCategory: (value: string) => value,
}));

import {
  getValidHistoryBuckets,
  nearestHistoryPointIndex,
  summarizeManagedEgressHistory,
  summarizeManagedEgressRecentUsage,
} from "./managed-egress-history";

describe("managed egress history helpers", () => {
  it("limits fine-grained buckets for long ranges", () => {
    expect(getValidHistoryBuckets("6h")).toEqual(["5m", "1h", "1d"]);
    expect(getValidHistoryBuckets("24h")).toEqual(["5m", "1h", "1d"]);
    expect(getValidHistoryBuckets("7d")).toEqual(["1h", "1d"]);
    expect(getValidHistoryBuckets("30d")).toEqual(["1h", "1d"]);
  });

  it("summarizes latest, peak, and hourly average", () => {
    expect(
      summarizeManagedEgressHistory({
        account_id: "account-1",
        project_id: "project-1",
        start: "2026-04-28T00:00:00.000Z",
        end: "2026-04-28T04:00:00.000Z",
        bucket: "1h",
        total_bytes: 800,
        categories_bytes: {},
        points: [
          {
            start: "2026-04-28T00:00:00.000Z",
            end: "2026-04-28T01:00:00.000Z",
            bytes: 100,
            categories_bytes: {},
          },
          {
            start: "2026-04-28T01:00:00.000Z",
            end: "2026-04-28T02:00:00.000Z",
            bytes: 500,
            categories_bytes: {},
          },
          {
            start: "2026-04-28T02:00:00.000Z",
            end: "2026-04-28T03:00:00.000Z",
            bytes: 200,
            categories_bytes: {},
          },
        ],
        top_projects: [],
        recent_events: [],
      }),
    ).toEqual({
      latestBytes: 200,
      peakBytes: 500,
      avgBytesPerHour: 200,
    });
  });

  it("computes recent 5-minute and 1-hour usage from history buckets", () => {
    expect(
      summarizeManagedEgressRecentUsage({
        account_id: "account-1",
        start: "2026-04-28T00:00:00.000Z",
        end: "2026-04-28T01:00:00.000Z",
        bucket: "5m",
        total_bytes: 780,
        categories_bytes: {},
        points: [
          {
            start: "2026-04-28T00:00:00.000Z",
            end: "2026-04-28T00:05:00.000Z",
            bytes: 10,
            categories_bytes: {},
          },
          {
            start: "2026-04-28T00:50:00.000Z",
            end: "2026-04-28T00:55:00.000Z",
            bytes: 70,
            categories_bytes: {},
          },
          {
            start: "2026-04-28T00:55:00.000Z",
            end: "2026-04-28T01:00:00.000Z",
            bytes: 700,
            categories_bytes: {},
          },
        ],
        top_projects: [],
        recent_events: [],
      }),
    ).toEqual({
      last5MinutesBytes: 700,
      lastHourBytes: 780,
    });
  });

  it("finds the nearest hover bucket index", () => {
    expect(
      nearestHistoryPointIndex(5, [
        { x: 0, y: 80 },
        { x: 140, y: 70 },
        { x: 280, y: 60 },
      ]),
    ).toBe(0);
    expect(
      nearestHistoryPointIndex(150, [
        { x: 0, y: 80 },
        { x: 140, y: 70 },
        { x: 280, y: 60 },
      ]),
    ).toBe(1);
    expect(
      nearestHistoryPointIndex(279, [
        { x: 0, y: 80 },
        { x: 140, y: 70 },
        { x: 280, y: 60 },
      ]),
    ).toBe(2);
  });
});
