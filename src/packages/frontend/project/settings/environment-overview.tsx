/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Card, Collapse, Space, Tag, Typography } from "antd";
import type { CSSProperties, ReactNode } from "react";
import { useMemo, useState } from "react";

import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { lite } from "@cocalc/frontend/lite";
import { useProjectEnv } from "@cocalc/frontend/project/use-project-env";
import { useProjectRootfs } from "@cocalc/frontend/project/use-project-rootfs";
import { useProjectSecrets } from "@cocalc/frontend/project/use-project-secrets";
import { PROJECT_CAPABILITY_SPECS } from "@cocalc/util/project-capabilities";
import { COLORS } from "@cocalc/util/theme";

import { Environment as CustomEnvironmentVariables } from "./environment";
import { LauncherDefaults } from "./launcher-defaults";
import { ProjectCapabilities } from "./project-capabilites";
import RootFilesystemImage from "./root-filesystem-image";
import { useRunQuota } from "./run-quota/hooks";
import { ProjectSecrets } from "./secrets";
import type { Project } from "./types";

type Mode = "project" | "flyout";

interface Props {
  project: Project;
  project_id: string;
  mode?: Mode;
}

type SummaryCardProps = {
  action?: ReactNode;
  icon: string;
  subtitle?: ReactNode;
  title: ReactNode;
  value: ReactNode;
};

type FeatureSummary = {
  availableCount: number;
  chips: string[];
  formatterCount: number;
};

const CARD_BODY_STYLE: CSSProperties = {
  padding: 12,
};

function normalizeEnv(env: unknown): Record<string, string> {
  if (typeof env != "object" || env == null || Array.isArray(env)) return {};
  const obj: Record<string, string> = {};
  for (const key in env) {
    const value = `${(env as Record<string, unknown>)[key]}`;
    if (value !== "") {
      obj[key] = value;
    }
  }
  return obj;
}

function countConfiguredEnv(env: unknown): number {
  return Object.keys(normalizeEnv(env)).length;
}

function featureSummary(avail: any): FeatureSummary {
  if (avail == null) {
    return { availableCount: 0, chips: [], formatterCount: 0 };
  }
  const chips: string[] = [];
  let availableCount = 0;
  for (const spec of PROJECT_CAPABILITY_SPECS) {
    if (avail[spec.key]) {
      availableCount += 1;
      chips.push(spec.label);
    }
  }
  const formatter = avail.formatting;
  const formatterCount =
    typeof formatter === "object" && formatter != null
      ? Object.values(formatter).filter(Boolean).length
      : formatter === true
        ? 1
        : 0;
  return { availableCount, chips: chips.slice(0, 8), formatterCount };
}

function rootfsLabel(rootfs: unknown): string {
  const image = `${(rootfs as any)?.image ?? ""}`.trim();
  if (image) {
    return image.split("/").slice(-1)[0] || image;
  }
  const imageId = `${(rootfs as any)?.image_id ?? ""}`.trim();
  if (imageId) {
    return imageId;
  }
  return "Project default";
}

function SummaryCard({
  action,
  icon,
  subtitle,
  title,
  value,
}: SummaryCardProps) {
  return (
    <Card
      size="small"
      style={{ borderColor: COLORS.GRAY_LL, height: "100%" }}
      styles={{ body: CARD_BODY_STYLE }}
    >
      <div
        style={{
          alignItems: "flex-start",
          display: "flex",
          gap: 10,
          height: "100%",
        }}
      >
        <div
          style={{
            alignItems: "center",
            background: COLORS.ANTD_BG_BLUE_L,
            borderRadius: 8,
            color: COLORS.ANTD_LINK_BLUE,
            display: "flex",
            flex: "0 0 auto",
            height: 32,
            justifyContent: "center",
            width: 32,
          }}
        >
          <Icon name={icon as any} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {title}
          </Typography.Text>
          <div
            style={{
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={typeof value === "string" ? value : undefined}
          >
            {value}
          </div>
          {subtitle != null ? (
            <div style={{ color: COLORS.GRAY_M, fontSize: 12 }}>{subtitle}</div>
          ) : undefined}
        </div>
        {action != null ? <div>{action}</div> : undefined}
      </div>
    </Card>
  );
}

export function EnvironmentOverview({
  project,
  project_id,
  mode = "project",
}: Props) {
  const isFlyout = mode === "flyout";
  const [activeKeys, setActiveKeys] = useState<string[]>([]);
  const { env } = useProjectEnv(project_id);
  const { secrets } = useProjectSecrets(project_id);
  const { rootfs } = useProjectRootfs(project_id);
  const runQuota = useRunQuota(project_id, null);
  const availableFeatures = useTypedRedux({ project_id }, "available_features");
  const configurationLoading = useTypedRedux(
    { project_id },
    "configuration_loading",
  );
  const hostId = `${project.get("host_id") ?? ""}`;

  const avail = availableFeatures?.toJS?.();
  const features = useMemo(() => featureSummary(avail), [avail]);
  const envCount = countConfiguredEnv(env);
  const secretCount = secrets?.length ?? 0;
  const runtimeImage = rootfsLabel(rootfs);
  const networkSummary = runQuota?.network ? "Internet enabled" : "Restricted";
  const memberHost = runQuota?.member_host ? "member host" : undefined;

  function expand(key: string): void {
    setActiveKeys((keys) => (keys.includes(key) ? keys : [...keys, key]));
  }

  function renderAction(key: string, label = "Details") {
    return (
      <Button size="small" type="link" onClick={() => expand(key)}>
        {label}
      </Button>
    );
  }

  const summaryColumns = isFlyout
    ? "repeat(2, minmax(0, 1fr))"
    : "repeat(3, minmax(0, 1fr))";

  const detailMode: Mode = "flyout";

  return (
    <Space
      direction="vertical"
      size={isFlyout ? 10 : 14}
      style={{ width: "100%" }}
    >
      <div
        style={{
          display: "grid",
          gap: isFlyout ? 8 : 10,
          gridTemplateColumns: summaryColumns,
        }}
      >
        <SummaryCard
          icon="disk-drive"
          title="Runtime Image"
          value={runtimeImage}
          subtitle="Base software environment"
          action={renderAction("rootfs")}
        />
        <SummaryCard
          icon="clipboard-check"
          title="Available Features"
          value={
            configurationLoading
              ? "Refreshing..."
              : `${features.availableCount} features`
          }
          subtitle={
            features.formatterCount
              ? `${features.formatterCount} formatter${features.formatterCount === 1 ? "" : "s"}`
              : "Feature probe"
          }
          action={renderAction("features", "Show")}
        />
        <SummaryCard
          icon="bars"
          title="Environment Variables"
          value={`${envCount} configured`}
          subtitle="Custom process environment"
          action={renderAction("env")}
        />
        <SummaryCard
          icon="key"
          title="Project Secrets"
          value={`${secretCount} secret${secretCount === 1 ? "" : "s"}`}
          subtitle="Mounted encrypted files"
          action={renderAction("secrets")}
        />
        <SummaryCard
          icon="network"
          title="Network"
          value={networkSummary}
          subtitle={memberHost ?? "Project access"}
        />
        <SummaryCard
          icon="terminal"
          title="SSH"
          value={lite ? "Unavailable" : "Available"}
          subtitle={hostId ? `Host ${hostId.slice(0, 8)}` : "Remote access"}
        />
      </div>

      {features.chips.length > 0 ? (
        <Card
          size="small"
          style={{ borderColor: COLORS.GRAY_LL }}
          styles={{ body: { padding: isFlyout ? 10 : 12 } }}
        >
          <div
            style={{
              alignItems: "center",
              display: "flex",
              gap: 8,
              justifyContent: "space-between",
              marginBottom: 8,
            }}
          >
            <Typography.Text strong>Available Features</Typography.Text>
            {renderAction("features", "Show all")}
          </div>
          <Space size={[6, 6]} wrap>
            {features.chips.map((label) => (
              <Tag key={label} color="green" style={{ marginInlineEnd: 0 }}>
                {label}
              </Tag>
            ))}
          </Space>
        </Card>
      ) : undefined}

      <Collapse
        activeKey={activeKeys}
        onChange={(keys) =>
          setActiveKeys(Array.isArray(keys) ? keys.map(String) : [String(keys)])
        }
        items={[
          {
            key: "launcher",
            label: "Launcher Defaults",
            children: <LauncherDefaults project_id={project_id} />,
          },
          {
            key: "env",
            label: "Custom Environment Variables",
            children: (
              <CustomEnvironmentVariables
                project_id={project_id}
                mode={detailMode}
              />
            ),
          },
          {
            key: "secrets",
            label: "Project Secrets",
            children: (
              <ProjectSecrets project_id={project_id} mode={detailMode} />
            ),
          },
          {
            key: "features",
            label: "Available Features and Formatters",
            children: (
              <ProjectCapabilities
                project={project}
                project_id={project_id}
                mode={detailMode}
              />
            ),
          },
          {
            key: "rootfs",
            label: "Root Filesystem Image",
            children: <RootFilesystemImage />,
          },
        ]}
      />
    </Space>
  );
}
