/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  DatePicker,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  MembershipAnalyticsBackfillOverview,
  MembershipAnalyticsDailyCountRow,
  MembershipAnalyticsEventSummaryRow,
  MembershipAnalyticsOverview,
  MembershipAnalyticsRevenueRow,
} from "@cocalc/conat/hub/api/purchases";
import ShowError from "@cocalc/frontend/components/error";
import { webapp_client } from "@cocalc/frontend/webapp-client";

const { RangePicker } = DatePicker;
const { Text } = Typography;

const DAY_MS = 24 * 60 * 60 * 1000;

const currencyFormatter = new Intl.NumberFormat("en-US", {
  currency: "USD",
  style: "currency",
});

function defaultRange(): [Dayjs, Dayjs] {
  const end = dayjs();
  return [dayjs(end.valueOf() - 90 * DAY_MS), end];
}

function queryRange(range: [Dayjs, Dayjs]): { start: Date; end: Date } {
  return {
    start: range[0].startOf("day").toDate(),
    end: range[1].add(1, "day").startOf("day").toDate(),
  };
}

function formatDate(value: Date | string): string {
  return dayjs(value).format("YYYY-MM-DD");
}

function formatMoney(value: number): string {
  return currencyFormatter.format(Number(value) || 0);
}

function formatEventType(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function MembershipAnalyticsAdmin() {
  const [range, setRange] = useState<[Dayjs, Dayjs]>(defaultRange);
  const [loading, setLoading] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [error, setError] = useState<string>("");
  const [overview, setOverview] = useState<MembershipAnalyticsOverview | null>(
    null,
  );
  const [backfillResult, setBackfillResult] =
    useState<MembershipAnalyticsBackfillOverview | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const { start, end } = queryRange(range);
      const result =
        await webapp_client.conat_client.hub.purchases.getMembershipAnalyticsOverview(
          { start, end },
        );
      setOverview(result);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  }, [range]);

  const backfill = useCallback(async () => {
    setBackfilling(true);
    setError("");
    try {
      const result =
        await webapp_client.conat_client.hub.purchases.backfillMembershipAnalyticsPurchases(
          { limit: 1000 },
        );
      setBackfillResult(result);
      await load();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setBackfilling(false);
    }
  }, [load]);

  const failedBays = useMemo(
    () => overview?.bays.filter((bay) => !bay.ok) ?? [],
    [overview],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space wrap>
        <Text strong>Range</Text>
        <RangePicker
          value={range}
          onChange={(value) => {
            if (value?.[0] && value?.[1]) {
              setRange([value[0], value[1]]);
            }
          }}
        />
        <Button onClick={() => void load()} loading={loading}>
          Refresh
        </Button>
        <Button onClick={() => void backfill()} loading={backfilling}>
          Backfill purchases
        </Button>
        {overview ? (
          <Text type="secondary">
            Checked {dayjs(overview.checked_at).format("YYYY-MM-DD HH:mm:ss")}
          </Text>
        ) : null}
      </Space>

      {loading ? <Spin /> : null}
      {error ? <ShowError error={error} /> : null}
      {backfillResult ? (
        <Alert
          type="success"
          showIcon
          message="Purchase backfill finished"
          description={`${backfillResult.inserted} inserted, ${backfillResult.skipped} skipped.`}
        />
      ) : null}

      {overview ? (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Space wrap>
            <Text strong>Bays</Text>
            {overview.bays.map((bay) => (
              <Tag color={bay.ok ? "green" : "red"} key={bay.bay_id}>
                {bay.bay_id}
              </Tag>
            ))}
          </Space>

          {failedBays.length > 0 ? (
            <Alert
              type="warning"
              showIcon
              message="Partial analytics result"
              description={failedBays
                .map((bay) => `${bay.bay_id}: ${bay.error ?? "unavailable"}`)
                .join("; ")}
            />
          ) : null}

          <RevenueTable rows={overview.revenue} />
          <EventsTable rows={overview.events} />
          <DailyCountsTable rows={overview.daily_counts} />
        </Space>
      ) : null}
    </Space>
  );
}

function RevenueTable({ rows }: { rows: MembershipAnalyticsRevenueRow[] }) {
  return (
    <Table<MembershipAnalyticsRevenueRow>
      bordered
      dataSource={rows}
      pagination={false}
      rowKey={(row) => `${row.membership_class}:${row.interval}`}
      size="small"
      title={() => "Revenue by tier and billing period"}
      columns={[
        {
          title: "Tier",
          dataIndex: "membership_class",
        },
        {
          title: "Period",
          dataIndex: "interval",
        },
        {
          title: "Gross revenue",
          dataIndex: "gross_revenue",
          align: "right",
          render: (value: number) => formatMoney(value),
        },
        {
          title: "Purchases",
          dataIndex: "purchase_count",
          align: "right",
        },
      ]}
    />
  );
}

function EventsTable({ rows }: { rows: MembershipAnalyticsEventSummaryRow[] }) {
  return (
    <Table<MembershipAnalyticsEventSummaryRow>
      bordered
      dataSource={rows}
      pagination={{ pageSize: 14, hideOnSinglePage: true }}
      rowKey={(row) => `${row.day}:${row.event_type}`}
      size="small"
      title={() => "Membership events by day"}
      columns={[
        {
          title: "Day",
          dataIndex: "day",
          render: formatDate,
        },
        {
          title: "Event",
          dataIndex: "event_type",
          render: formatEventType,
        },
        {
          title: "Count",
          dataIndex: "count",
          align: "right",
        },
        {
          title: "Amount",
          dataIndex: "amount",
          align: "right",
          render: (value: number) => formatMoney(value),
        },
      ]}
    />
  );
}

function DailyCountsTable({
  rows,
}: {
  rows: MembershipAnalyticsDailyCountRow[];
}) {
  return (
    <Table<MembershipAnalyticsDailyCountRow>
      bordered
      dataSource={rows}
      pagination={{ pageSize: 20, hideOnSinglePage: true }}
      rowKey={(row) =>
        [
          row.snapshot_date,
          row.bay_id,
          row.membership_class,
          row.source,
          row.interval,
          row.trial_status,
        ].join(":")
      }
      size="small"
      title={() => "Daily membership count snapshots"}
      columns={[
        {
          title: "Day",
          dataIndex: "snapshot_date",
          render: formatDate,
        },
        {
          title: "Scope",
          dataIndex: "bay_id",
        },
        {
          title: "Tier",
          dataIndex: "membership_class",
        },
        {
          title: "Source",
          dataIndex: "source",
        },
        {
          title: "Period",
          dataIndex: "interval",
        },
        {
          title: "Trial",
          dataIndex: "trial_status",
        },
        {
          title: "Accounts",
          dataIndex: "active_account_count",
          align: "right",
        },
        {
          title: "Subscriptions",
          dataIndex: "subscription_count",
          align: "right",
        },
      ]}
    />
  );
}
