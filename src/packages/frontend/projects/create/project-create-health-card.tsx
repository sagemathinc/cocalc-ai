/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { Alert, Button, Card, Progress, Space, Tag, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";

import type { AccountRuntimeSponsorStatus } from "@cocalc/conat/hub/api/projects";
import type { MembershipDetails } from "@cocalc/conat/hub/api/purchases";
import { redux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { humanSize } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";

const { Text } = Typography;

type GaugeTone = "ok" | "warning" | "danger" | "unknown";

type Gauge = {
  key: string;
  label: string;
  value: string;
  caption: string;
  percent?: number;
  tone: GaugeTone;
};

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function percentOf(current?: number, limit?: number): number | undefined {
  if (current == null || limit == null || limit <= 0) return undefined;
  return Math.min(100, Math.max(0, Math.round((current / limit) * 100)));
}

function toneFor({
  current,
  limit,
  over,
}: {
  current?: number;
  limit?: number;
  over?: boolean;
}): GaugeTone {
  if (over) return "danger";
  if (current == null || limit == null || limit <= 0) return "unknown";
  if (current >= limit) return "danger";
  if (current / limit >= 0.8) return "warning";
  return "ok";
}

function progressStatus(tone: GaugeTone): "normal" | "exception" | "success" {
  if (tone === "danger") return "exception";
  if (tone === "ok") return "success";
  return "normal";
}

function gaugeTag(tone: GaugeTone) {
  switch (tone) {
    case "danger":
      return <Tag color="red">Limit</Tag>;
    case "warning":
      return <Tag color="gold">Close</Tag>;
    case "ok":
      return <Tag color="green">OK</Tag>;
    default:
      return <Tag>Unknown</Tag>;
  }
}

function projectGauge(details?: MembershipDetails | null): Gauge {
  const usage = details?.usage_status;
  const limits =
    details?.selected?.effective_limits ??
    details?.selected?.entitlements?.usage_limits;
  const current = nonnegativeNumber(usage?.owned_project_count);
  const limit =
    positiveNumber(usage?.max_projects) ?? positiveNumber(limits?.max_projects);
  const tone = toneFor({
    current,
    limit,
    over: usage?.over_max_projects,
  });
  return {
    key: "projects",
    label: "Projects",
    value:
      current == null
        ? "Loading"
        : limit == null
          ? `${current}`
          : `${current}/${limit}`,
    caption:
      limit == null
        ? "No project slot limit reported."
        : "Delete projects or upgrade if this fills up.",
    percent: percentOf(current, limit),
    tone,
  };
}

function storageGauge(details?: MembershipDetails | null): Gauge {
  const usage = details?.usage_status;
  const limits =
    details?.selected?.effective_limits ??
    details?.selected?.entitlements?.usage_limits;
  const current = nonnegativeNumber(usage?.total_storage_bytes);
  const softLimit =
    positiveNumber(usage?.total_storage_soft_bytes) ??
    positiveNumber(limits?.total_storage_soft_bytes);
  const hardLimit =
    positiveNumber(usage?.total_storage_hard_bytes) ??
    positiveNumber(limits?.total_storage_hard_bytes);
  const limit = hardLimit ?? softLimit;
  const tone = toneFor({
    current,
    limit,
    over: usage?.over_total_storage_hard || usage?.over_total_storage_soft,
  });
  const partial =
    (usage?.unsampled_project_count ?? 0) > 0 ||
    (usage?.measurement_error_count ?? 0) > 0;
  return {
    key: "storage",
    label: "Storage",
    value:
      current == null
        ? "Loading"
        : limit == null
          ? humanSize(current)
          : `${humanSize(current)} / ${humanSize(limit)}`,
    caption: partial
      ? "Storage estimate is partial. Archive projects to reduce counted usage."
      : "Archive projects to reduce counted storage.",
    percent: percentOf(current, limit),
    tone,
  };
}

function runtimeGauge(status?: AccountRuntimeSponsorStatus | null): Gauge {
  const current = nonnegativeNumber(status?.current);
  const limit = positiveNumber(status?.limit);
  const tone = toneFor({ current, limit });
  return {
    key: "runtime",
    label: "Running",
    value:
      current == null
        ? "Loading"
        : limit == null
          ? `${current}`
          : `${current}/${limit}`,
    caption:
      limit == null
        ? "No simultaneous running-project limit reported."
        : "Create and Open uses a running-project slot.",
    percent: percentOf(current, limit),
    tone,
  };
}

function healthMessage(gauges: Gauge[]): string | undefined {
  const danger = gauges.find((gauge) => gauge.tone === "danger");
  if (danger?.key === "projects") {
    return "Project limit reached. Delete projects or upgrade before creating more.";
  }
  if (danger?.key === "storage") {
    return "Storage limit reached. Archive or delete projects, or upgrade before adding storage.";
  }
  if (danger?.key === "runtime") {
    return "Running-project slots are full. Creating without opening is fine; starting will need a slot.";
  }
  const warning = gauges.find((gauge) => gauge.tone === "warning");
  if (warning) {
    return "You are close to one membership limit. This project can still be adjusted later.";
  }
  return undefined;
}

function GaugeCard({ gauge }: { gauge: Gauge }) {
  return (
    <Card size="small" styles={{ body: { padding: "8px 10px" } }}>
      <Space orientation="vertical" size={4} style={{ width: "100%" }}>
        <Space
          size="small"
          style={{ width: "100%", justifyContent: "space-between" }}
        >
          <Text type="secondary" style={{ fontSize: 12 }}>
            {gauge.label}
          </Text>
          {gaugeTag(gauge.tone)}
        </Space>
        <Text strong style={{ color: COLORS.GRAY_D }}>
          {gauge.value}
        </Text>
        {gauge.percent != null && (
          <Progress
            percent={gauge.percent}
            showInfo={false}
            size="small"
            status={progressStatus(gauge.tone)}
          />
        )}
        <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.25 }}>
          {gauge.caption}
        </Text>
      </Space>
    </Card>
  );
}

export function ProjectCreateHealthCard({ open }: { open: boolean }) {
  const [membership, setMembership] = useState<MembershipDetails | null>(null);
  const [runtime, setRuntime] = useState<AccountRuntimeSponsorStatus | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [runtimeActionError, setRuntimeActionError] = useState<string>("");
  const [stoppingProjectIds, setStoppingProjectIds] = useState<
    Record<string, true>
  >({});
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!open) return;
    let canceled = false;
    setLoading(true);
    setError("");
    Promise.all([
      webapp_client.conat_client.hub.purchases.getMembershipDetails({}),
      webapp_client.conat_client.hub.projects.getAccountRuntimeSponsorStatus(
        {},
      ),
    ])
      .then(([nextMembership, nextRuntime]) => {
        if (canceled) return;
        setMembership(nextMembership);
        setRuntime(nextRuntime);
      })
      .catch((err) => {
        if (canceled) return;
        setError(`${err}`);
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [open, reloadToken]);

  const gauges = useMemo(
    () => [
      projectGauge(membership),
      runtimeGauge(runtime),
      storageGauge(membership),
    ],
    [membership, runtime],
  );
  const message = healthMessage(gauges);
  const runtimeLimit = positiveNumber(runtime?.limit);
  const runtimeCurrent = nonnegativeNumber(runtime?.current);
  const runtimeFull =
    runtimeLimit != null &&
    runtimeCurrent != null &&
    runtimeCurrent >= runtimeLimit;
  const visibleRuntimeProjects =
    runtime?.active_projects.filter((project) => project.visible !== false) ??
    [];
  const hiddenRuntimeProjectCount =
    (runtime?.active_projects.length ?? 0) - visibleRuntimeProjects.length;

  async function stopRuntimeProject(project_id: string) {
    setRuntimeActionError("");
    setStoppingProjectIds((ids) => ({ ...ids, [project_id]: true }));
    try {
      await redux.getActions("projects").stop_project(project_id);
      setReloadToken((token) => token + 1);
    } catch (err) {
      setRuntimeActionError(`${err}`);
    } finally {
      setStoppingProjectIds((ids) => {
        const next = { ...ids };
        delete next[project_id];
        return next;
      });
    }
  }

  return (
    <Card
      size="small"
      styles={{ body: { padding: 12 } }}
      style={{
        borderColor: COLORS.GRAY_LL,
        background: COLORS.GRAY_LLL,
      }}
    >
      <Space orientation="vertical" size="small" style={{ width: "100%" }}>
        <Space style={{ width: "100%", justifyContent: "space-between" }}>
          <Space size="small">
            <Icon name="dashboard" />
            <Text strong>Account capacity</Text>
          </Space>
          <Button
            size="small"
            type="text"
            onClick={() => setReloadToken((token) => token + 1)}
            loading={loading}
          >
            Refresh
          </Button>
        </Space>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: 8,
          }}
        >
          {gauges.map((gauge) => (
            <GaugeCard key={gauge.key} gauge={gauge} />
          ))}
        </div>
        {message && <Alert type="info" showIcon message={message} />}
        {runtimeFull && visibleRuntimeProjects.length > 0 && (
          <Card size="small" styles={{ body: { padding: "8px 10px" } }}>
            <Space
              orientation="vertical"
              size="small"
              style={{ width: "100%" }}
            >
              <Text type="secondary">
                Stop one running project to free a slot before using Create and
                Open.
              </Text>
              <Space orientation="vertical" size={6} style={{ width: "100%" }}>
                {visibleRuntimeProjects.map((project) => (
                  <div
                    key={project.project_id}
                    style={{
                      alignItems: "center",
                      display: "flex",
                      gap: 8,
                      justifyContent: "space-between",
                    }}
                  >
                    <Text ellipsis>
                      {project.title || project.project_id.slice(0, 8)}
                      {project.state ? ` (${project.state})` : ""}
                    </Text>
                    {project.can_stop !== false && (
                      <Button
                        size="small"
                        loading={!!stoppingProjectIds[project.project_id]}
                        onClick={() => stopRuntimeProject(project.project_id)}
                      >
                        Stop
                      </Button>
                    )}
                  </div>
                ))}
              </Space>
              {hiddenRuntimeProjectCount > 0 && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {hiddenRuntimeProjectCount} sponsored running{" "}
                  {hiddenRuntimeProjectCount === 1
                    ? "project is"
                    : "projects are"}{" "}
                  not shown because your account is not a collaborator.
                </Text>
              )}
            </Space>
          </Card>
        )}
        {runtimeActionError && (
          <Alert
            type="warning"
            showIcon
            message="Unable to stop project"
            description={runtimeActionError}
          />
        )}
        {error && (
          <Alert
            type="warning"
            showIcon
            message="Unable to load account capacity"
            description={error}
          />
        )}
      </Space>
    </Card>
  );
}
