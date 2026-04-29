/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Empty, Space, Spin, Tag, Typography } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  ManagedEgressAccountSummary,
  ManagedEgressAdminOverview,
  ManagedEgressAdminProjectSummary,
} from "@cocalc/conat/hub/api/purchases";
import ShowError from "@cocalc/frontend/components/error";
import { ManagedEgressHistoryButton } from "@cocalc/frontend/purchases/managed-egress-history";
import {
  ManagedEgressRecentEventsButton,
  formatManagedEgressCategory,
} from "@cocalc/frontend/purchases/managed-egress-recent-events";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { humanSize } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";

const { Paragraph, Text } = Typography;

const DAY_MS = 24 * 60 * 60 * 1000;
const REFRESH_MS = 60 * 1000;

function getAccountLabel(account: {
  account_id: string;
  email_address?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}): string {
  const fullName =
    `${account.first_name ?? ""} ${account.last_name ?? ""}`.trim();
  if (fullName && account.email_address) {
    return `${fullName} (${account.email_address})`;
  }
  return fullName || account.email_address || account.account_id;
}

function getProjectLabel(project: ManagedEgressAdminProjectSummary): string {
  return (
    `${project.project_title ?? project.project_id ?? ""}`.trim() ||
    "Account-wide session traffic"
  );
}

function categoryEntries(categories: Record<string, number>): Array<{
  category: string;
  bytes: number;
}> {
  return Object.entries(categories)
    .map(([category, bytes]) => ({
      category,
      bytes: Math.max(0, Number(bytes) || 0),
    }))
    .filter((entry) => entry.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes || a.category.localeCompare(b.category));
}

function TopAccounts({
  accounts,
}: {
  accounts: ManagedEgressAccountSummary[];
}) {
  if (accounts.length === 0) {
    return (
      <Text type="secondary">No account-attributed egress in this window.</Text>
    );
  }
  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      {accounts.map((account) => (
        <div key={account.account_id}>
          <Space wrap>
            <Text strong>{getAccountLabel(account)}</Text>
            <Tag>{humanSize(account.bytes)}</Tag>
            <ManagedEgressHistoryButton
              buttonText="Account history"
              user_account_id={account.account_id}
            />
          </Space>
        </div>
      ))}
    </Space>
  );
}

function TopProjects({
  projects,
}: {
  projects: ManagedEgressAdminProjectSummary[];
}) {
  if (projects.length === 0) {
    return (
      <Text type="secondary">No project-attributed egress in this window.</Text>
    );
  }
  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      {projects.map((project) => (
        <div key={`${project.account_id}:${project.project_id ?? "none"}`}>
          <Space wrap>
            <Text strong>{getProjectLabel(project)}</Text>
            <Tag>{humanSize(project.bytes)}</Tag>
            <Text type="secondary">{getAccountLabel(project)}</Text>
            <ManagedEgressHistoryButton
              buttonText="Project history"
              user_account_id={project.account_id}
              project_id={project.project_id ?? undefined}
            />
          </Space>
        </div>
      ))}
    </Space>
  );
}

export function ManagedEgressAdminOverview() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [overview, setOverview] = useState<ManagedEgressAdminOverview | null>(
    null,
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const end = new Date();
      const start = new Date(end.getTime() - DAY_MS);
      const result =
        (await webapp_client.conat_client.hub.purchases.getManagedEgressAdminOverview(
          {
            start,
            end,
            recent_event_limit: 10,
            top_account_limit: 8,
            top_project_limit: 8,
          },
        )) as ManagedEgressAdminOverview;
      setOverview(result);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => {
      void load();
    }, REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [load]);

  const categories = useMemo(
    () => categoryEntries(overview?.categories_bytes ?? {}),
    [overview],
  );

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Paragraph style={{ marginBottom: 0 }}>
        Operator view of the last 24 hours of managed network egress across all
        accounts. Use this to spot the current biggest cost drivers, then drill
        into account or project history.
      </Paragraph>

      <Space wrap>
        <div style={{ minWidth: 180 }}>
          <Text strong>Last 24h total</Text>
          <div style={{ fontSize: "20px", marginTop: "4px" }}>
            {overview ? humanSize(overview.total_bytes) : loading ? "…" : "0 B"}
          </div>
        </div>
        <div style={{ minWidth: 200 }}>
          <Text strong>Historical drilldown</Text>
          <div style={{ marginTop: "6px" }}>
            <Text type="secondary">
              Open a user or project history directly from the lists below.
            </Text>
          </div>
        </div>
        <Button onClick={() => void load()}>Refresh</Button>
      </Space>

      {loading ? <Spin /> : null}
      {error ? <ShowError error={error} /> : null}
      {!loading && !error && overview && overview.total_bytes <= 0 ? (
        <Alert
          message="No managed egress recorded in the last 24 hours."
          type="info"
          showIcon
        />
      ) : null}

      {!loading && !error && overview ? (
        <>
          <div>
            <Text strong>Category totals</Text>
            <div style={{ marginTop: "8px" }}>
              {categories.length > 0 ? (
                <Space wrap>
                  {categories.map((entry) => (
                    <Tag key={entry.category}>
                      {formatManagedEgressCategory(entry.category)}:{" "}
                      {humanSize(entry.bytes)}
                    </Tag>
                  ))}
                </Space>
              ) : (
                <Empty
                  description="No managed egress categories in this window."
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                />
              )}
            </div>
          </div>

          <div
            style={{
              border: `1px solid ${COLORS.GRAY_LL}`,
              borderRadius: "8px",
              padding: "12px 14px",
            }}
          >
            <Text strong>Top recent egress accounts (24h)</Text>
            <div style={{ marginTop: "10px" }}>
              <TopAccounts accounts={overview.top_accounts} />
            </div>
          </div>

          <div
            style={{
              border: `1px solid ${COLORS.GRAY_LL}`,
              borderRadius: "8px",
              padding: "12px 14px",
            }}
          >
            <Text strong>Top recent egress projects (24h)</Text>
            <div style={{ marginTop: "10px" }}>
              <TopProjects projects={overview.top_projects} />
            </div>
          </div>

          <div>
            <Text strong>Recent managed egress events</Text>
            <div style={{ marginTop: "8px" }}>
              <ManagedEgressRecentEventsButton
                events={overview.recent_events}
              />
            </div>
          </div>
        </>
      ) : null}
    </Space>
  );
}
