/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Empty,
  Segmented,
  Space,
  Spin,
  Tag,
  Typography,
} from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import type {
  ManagedCpuAccountSummary,
  ManagedCpuAdminOverview as ManagedCpuAdminOverviewData,
  ManagedCpuAdminProjectSummary,
  ManagedCpuEventSummary,
  ManagedEgressAccountSummary,
  ManagedEgressAdminOverview,
  ManagedEgressAdminProjectSummary,
} from "@cocalc/conat/hub/api/purchases";
import ShowError from "@cocalc/frontend/components/error";
import { CopyToClipBoard } from "@cocalc/frontend/components";
import {
  ManagedEgressHistoryButton,
  ManagedEgressRateSummary,
} from "@cocalc/frontend/purchases/managed-egress-history";
import { ManagedEgressRecentEventsButton } from "@cocalc/frontend/purchases/managed-egress-recent-events";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { humanSize } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";

const { Paragraph, Text } = Typography;

const REFRESH_MS = 60 * 1000;

const RANGE_SPECS = [
  { key: "5h", label: "5h", durationMs: 5 * 60 * 60 * 1000 },
  { key: "7d", label: "7d", durationMs: 7 * 24 * 60 * 60 * 1000 },
  { key: "24h", label: "24h", durationMs: 24 * 60 * 60 * 1000 },
] as const;

type RangeKey = (typeof RANGE_SPECS)[number]["key"];

function getRangeSpec(key: RangeKey) {
  return RANGE_SPECS.find((range) => range.key === key) ?? RANGE_SPECS[0];
}

function formatCpuSeconds(seconds: number): string {
  const hours = Math.max(0, Number(seconds) || 0) / 3600;
  let digits = 0;
  if (hours < 1) {
    digits = 3;
  } else if (hours < 10) {
    digits = 2;
  } else if (hours < 100) {
    digits = 1;
  }
  return `${hours.toFixed(digits)} CPU-hours`;
}

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

function getProjectLabel(project: {
  project_id?: string | null;
  project_title?: string | null;
}): string {
  return (
    `${project.project_title ?? project.project_id ?? ""}`.trim() ||
    "Account-wide activity"
  );
}

function PanelBox({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div
      style={{
        border: `1px solid ${COLORS.GRAY_LL}`,
        borderRadius: "8px",
        padding: "12px 14px",
      }}
    >
      <Text strong>{title}</Text>
      <div style={{ marginTop: "10px" }}>{children}</div>
    </div>
  );
}

function AccountActions({ account_id }: { account_id: string }) {
  return (
    <Space wrap>
      <CopyToClipBoard value={account_id} copyTip="Copied account_id!" />
      <ManagedEgressHistoryButton
        buttonText="Egress history"
        user_account_id={account_id}
        size="small"
      />
    </Space>
  );
}

function TopCpuAccounts({
  accounts,
}: {
  accounts: ManagedCpuAccountSummary[];
}) {
  if (accounts.length === 0) {
    return (
      <Text type="secondary">No account-attributed CPU in this window.</Text>
    );
  }
  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      {accounts.map((account) => (
        <div key={account.account_id}>
          <Space wrap>
            <Text strong>{getAccountLabel(account)}</Text>
            <Tag>{formatCpuSeconds(account.cpu_seconds)}</Tag>
            <AccountActions account_id={account.account_id} />
          </Space>
        </div>
      ))}
    </Space>
  );
}

function TopCpuProjects({
  projects,
}: {
  projects: ManagedCpuAdminProjectSummary[];
}) {
  if (projects.length === 0) {
    return (
      <Text type="secondary">No project-attributed CPU in this window.</Text>
    );
  }
  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      {projects.map((project) => (
        <div
          key={`${project.account_id}:${project.project_id ?? "none"}:${project.host_id ?? "none"}`}
        >
          <Space wrap>
            <Text strong>{getProjectLabel(project)}</Text>
            <Tag>{formatCpuSeconds(project.cpu_seconds)}</Tag>
            {project.host_id ? <Tag>Host {project.host_id}</Tag> : null}
            <Text type="secondary">{getAccountLabel(project)}</Text>
            <AccountActions account_id={project.account_id} />
            {project.project_id ? (
              <Button
                size="small"
                href={`/projects/${project.project_id}/files/`}
                target="_blank"
              >
                Open project
              </Button>
            ) : null}
          </Space>
        </div>
      ))}
    </Space>
  );
}

function TopEgressAccounts({
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
            <AccountActions account_id={account.account_id} />
          </Space>
        </div>
      ))}
    </Space>
  );
}

function TopEgressProjects({
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
            <AccountActions account_id={project.account_id} />
            {project.project_id ? (
              <Button
                size="small"
                href={`/projects/${project.project_id}/files/`}
                target="_blank"
              >
                Open project
              </Button>
            ) : null}
          </Space>
        </div>
      ))}
    </Space>
  );
}

function RecentCpuEvents({ events }: { events: ManagedCpuEventSummary[] }) {
  if (events.length === 0) {
    return (
      <Empty
        description="No recent CPU events in this window."
        image={Empty.PRESENTED_IMAGE_SIMPLE}
      />
    );
  }
  return (
    <Space direction="vertical" size={8} style={{ width: "100%" }}>
      {events.map((event, i) => (
        <div
          key={`${event.account_id ?? "none"}:${event.project_id ?? "none"}:${event.sample_ended_at}:${i}`}
        >
          <Space wrap>
            <Tag>{formatCpuSeconds(event.cpu_seconds)}</Tag>
            <Text strong>{getProjectLabel(event)}</Text>
            {event.host_id ? <Tag>Host {event.host_id}</Tag> : null}
            {event.source ? <Text type="secondary">{event.source}</Text> : null}
            <Text type="secondary">
              {new Date(event.sample_ended_at).toLocaleString()}
            </Text>
          </Space>
        </div>
      ))}
    </Space>
  );
}

export function ManagedCpuAdminOverview() {
  const [rangeKey, setRangeKey] = useState<RangeKey>("5h");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [cpuOverview, setCpuOverview] =
    useState<ManagedCpuAdminOverviewData | null>(null);
  const [egressOverview, setEgressOverview] =
    useState<ManagedEgressAdminOverview | null>(null);

  const range = useMemo(() => getRangeSpec(rangeKey), [rangeKey]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const end = new Date();
      const start = new Date(end.getTime() - range.durationMs);
      const [cpu, egress] = await Promise.all([
        webapp_client.conat_client.hub.purchases.getManagedCpuAdminOverview({
          start,
          end,
          recent_event_limit: 12,
          top_account_limit: 10,
          top_project_limit: 10,
        }),
        webapp_client.conat_client.hub.purchases.getManagedEgressAdminOverview({
          start,
          end,
          recent_event_limit: 10,
          top_account_limit: 8,
          top_project_limit: 8,
        }),
      ]);
      setCpuOverview(cpu as ManagedCpuAdminOverviewData);
      setEgressOverview(egress as ManagedEgressAdminOverview);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  }, [range.durationMs]);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => {
      void load();
    }, REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [load]);

  const hasNoCpu = (cpuOverview?.total_cpu_seconds ?? 0) <= 0;
  const hasNoEgress = (egressOverview?.total_bytes ?? 0) <= 0;

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Paragraph style={{ marginBottom: 0 }}>
        Operator view of CPU-heavy accounts and projects, with managed egress
        shown in the same window as an additional abuse signal. CPU is measured
        as CPU-hours; high usage is a review signal, not by itself a verdict.
      </Paragraph>

      <Space wrap>
        <Text strong>Range</Text>
        <Segmented
          options={RANGE_SPECS.map((range) => ({
            label: range.label,
            value: range.key,
          }))}
          onChange={(value) => setRangeKey(value as RangeKey)}
          value={rangeKey}
        />
        <div style={{ minWidth: 180 }}>
          <Text strong>{`${range.label} CPU total`}</Text>
          <div style={{ fontSize: "20px", marginTop: "4px" }}>
            {cpuOverview
              ? formatCpuSeconds(cpuOverview.total_cpu_seconds)
              : loading
                ? "…"
                : "0 CPU-hours"}
          </div>
        </div>
        <div style={{ minWidth: 180 }}>
          <Text strong>{`${range.label} egress total`}</Text>
          <div style={{ fontSize: "20px", marginTop: "4px" }}>
            {egressOverview
              ? humanSize(egressOverview.total_bytes)
              : loading
                ? "…"
                : "0 B"}
          </div>
        </div>
        <Button onClick={() => void load()}>Refresh</Button>
      </Space>

      {loading ? <Spin /> : null}
      {error ? <ShowError error={error} /> : null}
      {!loading &&
      !error &&
      cpuOverview &&
      egressOverview &&
      hasNoCpu &&
      hasNoEgress ? (
        <Alert
          message={`No managed CPU or egress recorded in the last ${range.label}.`}
          type="info"
          showIcon
        />
      ) : null}

      {!loading && !error && cpuOverview && egressOverview ? (
        <>
          <PanelBox title={`Top CPU accounts (${range.label})`}>
            <TopCpuAccounts accounts={cpuOverview.top_accounts} />
          </PanelBox>

          <PanelBox title={`Top CPU projects (${range.label})`}>
            <TopCpuProjects projects={cpuOverview.top_projects} />
          </PanelBox>

          <PanelBox title={`Top egress accounts (${range.label})`}>
            <TopEgressAccounts accounts={egressOverview.top_accounts} />
          </PanelBox>

          <PanelBox title={`Top egress projects (${range.label})`}>
            <TopEgressProjects projects={egressOverview.top_projects} />
          </PanelBox>

          <PanelBox title="Recent CPU samples">
            <RecentCpuEvents events={cpuOverview.recent_events} />
          </PanelBox>

          <PanelBox title="Recent managed egress events">
            <ManagedEgressRecentEventsButton
              events={egressOverview.recent_events}
            />
          </PanelBox>

          <PanelBox title="Recent managed egress rate">
            <ManagedEgressRateSummary />
          </PanelBox>
        </>
      ) : null}
    </Space>
  );
}
