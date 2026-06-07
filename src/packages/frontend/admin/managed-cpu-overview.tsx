/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Empty,
  Input,
  Segmented,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import type {
  AbuseReviewAnnotation,
  ManagedCpuAccountSummary,
  ManagedCpuAdminOverview as ManagedCpuAdminOverviewData,
  ManagedCpuAdminProjectSummary,
  ManagedCpuEventSummary,
  ManagedEgressAccountSummary,
  ManagedEgressAdminOverview,
  ManagedEgressAdminProjectSummary,
  MembershipUsageWindowResetTarget,
} from "@cocalc/conat/hub/api/purchases";
import ShowError from "@cocalc/frontend/components/error";
import { CopyToClipBoard } from "@cocalc/frontend/components";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import {
  AbuseAnnotationControls,
  reviewSortRank,
} from "@cocalc/frontend/admin/abuse-annotation-controls";
import { ManagedCpuHistoryButton } from "@cocalc/frontend/purchases/managed-cpu-history";
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

function formatAccountSummary(account: {
  account_id: string;
  email_address?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}): string {
  return `${getAccountLabel(account)} (${account.account_id})`;
}

function formatProjectSummary(project: {
  account_id: string;
  email_address?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  project_id?: string | null;
  project_title?: string | null;
  host_id?: string | null;
}): string {
  const projectPart = `${getProjectLabel(project)} (${project.project_id ?? "no project id"})`;
  const hostPart = project.host_id ? `, host ${project.host_id}` : "";
  return `${projectPart}${hostPart}, ${formatAccountSummary(project)}`;
}

function numberedLines<T>(
  entries: T[],
  formatter: (entry: T) => string,
): string[] {
  if (entries.length === 0) {
    return ["None"];
  }
  return entries.map((entry, i) => `${i + 1}. ${formatter(entry)}`);
}

function buildMarkdownSummary({
  rangeLabel,
  cpuOverview,
  egressOverview,
}: {
  rangeLabel: string;
  cpuOverview: ManagedCpuAdminOverviewData;
  egressOverview: ManagedEgressAdminOverview;
}): string {
  return [
    `# CPU & Abuse Signals, ${rangeLabel} window`,
    "",
    `Total CPU: ${formatCpuSeconds(cpuOverview.total_cpu_seconds)}`,
    `Total egress: ${humanSize(egressOverview.total_bytes)}`,
    "",
    "## Top CPU accounts",
    ...numberedLines(
      cpuOverview.top_accounts,
      (account) =>
        `${formatAccountSummary(account)} - ${formatCpuSeconds(account.cpu_seconds)}`,
    ),
    "",
    "## Top CPU projects",
    ...numberedLines(
      cpuOverview.top_projects,
      (project) =>
        `${formatProjectSummary(project)} - ${formatCpuSeconds(project.cpu_seconds)}`,
    ),
    "",
    "## Top egress accounts",
    ...numberedLines(
      egressOverview.top_accounts,
      (account) =>
        `${formatAccountSummary(account)} - ${humanSize(account.bytes)}`,
    ),
    "",
    "## Top egress projects",
    ...numberedLines(
      egressOverview.top_projects,
      (project) =>
        `${formatProjectSummary(project)} - ${humanSize(project.bytes)}`,
    ),
  ].join("\n");
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

function AccountActions({
  account_id,
  project_id,
  active_annotations,
  defaultCategory,
  evidence,
  onAnnotationChange,
}: {
  account_id: string;
  project_id?: string | null;
  active_annotations?: AbuseReviewAnnotation[];
  defaultCategory: "cpu" | "egress";
  evidence?: Record<string, unknown>;
  onAnnotationChange?: () => void;
}) {
  return (
    <Space wrap>
      <CopyToClipBoard value={account_id} copyTip="Copied account_id!" />
      <ManagedCpuHistoryButton
        buttonText="CPU history"
        user_account_id={account_id}
        project_id={project_id ?? undefined}
        size="small"
      />
      <ManagedEgressHistoryButton
        buttonText="Egress history"
        user_account_id={account_id}
        size="small"
      />
      <AbuseAnnotationControls
        account_id={account_id}
        project_id={project_id}
        active_annotations={active_annotations}
        defaultCategory={defaultCategory}
        evidence={evidence}
        onChange={onAnnotationChange}
      />
    </Space>
  );
}

function TopCpuAccounts({
  accounts,
  onAnnotationChange,
}: {
  accounts: ManagedCpuAccountSummary[];
  onAnnotationChange?: () => void;
}) {
  if (accounts.length === 0) {
    return (
      <Text type="secondary">No account-attributed CPU in this window.</Text>
    );
  }
  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      {[...accounts]
        .sort(
          (a, b) =>
            reviewSortRank(a.active_abuse_annotations) -
              reviewSortRank(b.active_abuse_annotations) ||
            b.cpu_seconds - a.cpu_seconds,
        )
        .map((account) => (
          <div key={account.account_id}>
            <Space wrap>
              <Text strong>{getAccountLabel(account)}</Text>
              <Tag>{formatCpuSeconds(account.cpu_seconds)}</Tag>
              <AccountActions
                account_id={account.account_id}
                active_annotations={account.active_abuse_annotations}
                defaultCategory="cpu"
                evidence={{
                  source: "top_cpu_account",
                  cpu_seconds: account.cpu_seconds,
                }}
                onAnnotationChange={onAnnotationChange}
              />
            </Space>
          </div>
        ))}
    </Space>
  );
}

function TopCpuProjects({
  projects,
  onAnnotationChange,
}: {
  projects: ManagedCpuAdminProjectSummary[];
  onAnnotationChange?: () => void;
}) {
  if (projects.length === 0) {
    return (
      <Text type="secondary">No project-attributed CPU in this window.</Text>
    );
  }
  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      {[...projects]
        .sort(
          (a, b) =>
            reviewSortRank(a.active_abuse_annotations) -
              reviewSortRank(b.active_abuse_annotations) ||
            b.cpu_seconds - a.cpu_seconds,
        )
        .map((project) => (
          <div
            key={`${project.account_id}:${project.project_id ?? "none"}:${project.host_id ?? "none"}`}
          >
            <Space wrap>
              <Text strong>{getProjectLabel(project)}</Text>
              <Tag>{formatCpuSeconds(project.cpu_seconds)}</Tag>
              {project.host_id ? <Tag>Host {project.host_id}</Tag> : null}
              <Text type="secondary">{getAccountLabel(project)}</Text>
              <AccountActions
                account_id={project.account_id}
                project_id={project.project_id}
                active_annotations={project.active_abuse_annotations}
                defaultCategory="cpu"
                evidence={{
                  source: "top_cpu_project",
                  cpu_seconds: project.cpu_seconds,
                  project_id: project.project_id,
                  host_id: project.host_id,
                }}
                onAnnotationChange={onAnnotationChange}
              />
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
  onAnnotationChange,
}: {
  accounts: ManagedEgressAccountSummary[];
  onAnnotationChange?: () => void;
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
            <AccountActions
              account_id={account.account_id}
              active_annotations={account.active_abuse_annotations}
              defaultCategory="egress"
              evidence={{
                source: "top_egress_account",
                bytes: account.bytes,
              }}
              onAnnotationChange={onAnnotationChange}
            />
          </Space>
        </div>
      ))}
    </Space>
  );
}

function TopEgressProjects({
  projects,
  onAnnotationChange,
}: {
  projects: ManagedEgressAdminProjectSummary[];
  onAnnotationChange?: () => void;
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
            <AccountActions
              account_id={project.account_id}
              project_id={project.project_id}
              defaultCategory="egress"
              evidence={{
                source: "top_egress_project",
                bytes: project.bytes,
                project_id: project.project_id,
              }}
              onAnnotationChange={onAnnotationChange}
            />
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

function MembershipUsageWindowReset({
  onReset,
}: {
  onReset: () => Promise<void>;
}) {
  const [windowTarget, setWindowTarget] =
    useState<MembershipUsageWindowResetTarget>("all");
  const [reason, setReason] = useState("");
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState("");
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction({
    onUnhandledError: (err) => setError(`${err}`),
  });

  async function resetWindows() {
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      setError("Enter a reset reason.");
      return;
    }
    setError("");
    try {
      await runFreshAuthAction(async () => {
        setResetting(true);
        try {
          await webapp_client.conat_client.hub.purchases.adminResetMembershipUsageWindows(
            {
              window: windowTarget,
              reason: trimmedReason,
              browser_id: webapp_client.browser_id,
            },
          );
          setReason("");
          await onReset();
          void message.success("Membership usage windows reset.");
        } finally {
          setResetting(false);
        }
      });
    } catch (err) {
      setError(`${err}`);
    }
  }

  return (
    <PanelBox title="Reset membership usage windows">
      <FreshAuthModal {...freshAuthModalProps} />
      <Space direction="vertical" size="small" style={{ width: "100%" }}>
        <Alert
          type="warning"
          showIcon
          message="Global reset for user-visible membership windows"
          description="This bumps the shared membership usage epoch for all accounts. Historical usage logs remain intact, but affected 5-hour and/or 7-day membership meters immediately start from a fresh window."
        />
        {error ? <ShowError error={error} /> : null}
        <Space wrap align="start">
          <div>
            <Text strong>Window</Text>
            <div style={{ marginTop: "4px", minWidth: 180 }}>
              <Select
                value={windowTarget}
                style={{ width: "100%" }}
                onChange={(value) =>
                  setWindowTarget(value as MembershipUsageWindowResetTarget)
                }
                options={[
                  { value: "all", label: "5-hour and 7-day" },
                  { value: "5h", label: "5-hour only" },
                  { value: "7d", label: "7-day only" },
                ]}
              />
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 360 }}>
            <Text strong>Reason</Text>
            <Input.TextArea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Explain why this global usage-window reset is needed."
              rows={2}
            />
          </div>
          <Button
            danger
            loading={resetting}
            disabled={!reason.trim()}
            onClick={() => void resetWindows()}
            style={{ marginTop: 22 }}
          >
            Reset windows
          </Button>
        </Space>
      </Space>
    </PanelBox>
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
  const copySummary = async () => {
    if (!cpuOverview || !egressOverview) return;
    try {
      await navigator.clipboard.writeText(
        buildMarkdownSummary({
          rangeLabel: range.label,
          cpuOverview,
          egressOverview,
        }),
      );
      void message.success("CPU and abuse summary copied.");
    } catch (err) {
      setError(`Unable to copy summary: ${err}`);
    }
  };

  const hasOverview = cpuOverview != null && egressOverview != null;
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
        <Button
          disabled={!cpuOverview || !egressOverview}
          onClick={() => void copySummary()}
        >
          Copy summary
        </Button>
        <ManagedCpuHistoryButton buttonText="Global CPU history" size="small" />
        <Button loading={loading && hasOverview} onClick={() => void load()}>
          Refresh
        </Button>
      </Space>

      <MembershipUsageWindowReset onReset={load} />

      {loading && !hasOverview ? <Spin /> : null}
      {error ? <ShowError error={error} /> : null}
      {!error && cpuOverview && egressOverview && hasNoCpu && hasNoEgress ? (
        <Alert
          message={`No managed CPU or egress recorded in the last ${range.label}.`}
          type="info"
          showIcon
        />
      ) : null}

      {!error && cpuOverview && egressOverview ? (
        <>
          <PanelBox title={`Top CPU accounts (${range.label})`}>
            <TopCpuAccounts
              accounts={cpuOverview.top_accounts}
              onAnnotationChange={load}
            />
          </PanelBox>

          <PanelBox title={`Top CPU projects (${range.label})`}>
            <TopCpuProjects
              projects={cpuOverview.top_projects}
              onAnnotationChange={load}
            />
          </PanelBox>

          <PanelBox title={`Top egress accounts (${range.label})`}>
            <TopEgressAccounts
              accounts={egressOverview.top_accounts}
              onAnnotationChange={load}
            />
          </PanelBox>

          <PanelBox title={`Top egress projects (${range.label})`}>
            <TopEgressProjects
              projects={egressOverview.top_projects}
              onAnnotationChange={load}
            />
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
