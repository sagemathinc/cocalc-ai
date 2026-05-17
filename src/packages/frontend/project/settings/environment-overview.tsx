/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Card, Collapse, Space, Typography } from "antd";
import type { CSSProperties, ReactNode } from "react";
import { useMemo, useRef, useState } from "react";

import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { lite } from "@cocalc/frontend/lite";
import { useProjectEnv } from "@cocalc/frontend/project/use-project-env";
import { useProjectRootfs } from "@cocalc/frontend/project/use-project-rootfs";
import { useProjectSecrets } from "@cocalc/frontend/project/use-project-secrets";
import {
  managedRootfsCatalogUrl,
  useRootfsImages,
} from "@cocalc/frontend/rootfs/manifest";
import { PROJECT_CAPABILITY_SPECS } from "@cocalc/util/project-capabilities";
import { COLORS } from "@cocalc/util/theme";

import { EnvironmentFeatureGroups } from "./environment-feature-groups";
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
  isLast?: boolean;
  subtitle?: ReactNode;
  title: ReactNode;
  value: ReactNode;
};

type FeatureSummary = {
  availableCount: number;
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
    return { availableCount: 0, formatterCount: 0 };
  }
  let availableCount = 0;
  for (const spec of PROJECT_CAPABILITY_SPECS) {
    if (avail[spec.key]) {
      availableCount += 1;
    }
  }
  const formatter = avail.formatting;
  const formatterCount =
    typeof formatter === "object" && formatter != null
      ? Object.values(formatter).filter(Boolean).length
      : formatter === true
        ? 1
        : 0;
  return { availableCount, formatterCount };
}

function rootfsLabel(rootfs: unknown, rootfsImages: any[]): string {
  const image = `${(rootfs as any)?.image ?? ""}`.trim();
  const imageId = `${(rootfs as any)?.image_id ?? ""}`.trim();
  const entry =
    (imageId
      ? rootfsImages.find((entry) => entry.id === imageId)
      : undefined) ??
    (image ? rootfsImages.find((entry) => entry.image === image) : undefined);
  if (entry?.label) {
    return entry.version ? `${entry.label} ${entry.version}` : entry.label;
  }
  if (image) {
    return image.split("/").slice(-1)[0] || image;
  }
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

function SummaryRow({
  action,
  icon,
  isLast,
  subtitle,
  title,
  value,
}: SummaryCardProps) {
  return (
    <div
      style={{
        alignItems: "center",
        borderBottom: isLast ? undefined : `1px solid ${COLORS.GRAY_LL}`,
        display: "grid",
        gap: 8,
        gridTemplateColumns: "24px minmax(0, 1fr) auto",
        padding: "8px 0",
      }}
    >
      <Icon
        name={icon as any}
        style={{ color: COLORS.ANTD_LINK_BLUE, fontSize: 15 }}
      />
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            alignItems: "baseline",
            display: "flex",
            gap: 6,
            minWidth: 0,
          }}
        >
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {title}
          </Typography.Text>
          <div
            style={{
              fontWeight: 600,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={typeof value === "string" ? value : undefined}
          >
            {value}
          </div>
        </div>
        {subtitle != null ? (
          <div style={{ color: COLORS.GRAY_M, fontSize: 12 }}>{subtitle}</div>
        ) : undefined}
      </div>
      {action != null ? <div>{action}</div> : undefined}
    </div>
  );
}

export function EnvironmentOverview({
  project,
  project_id,
  mode = "project",
}: Props) {
  const isFlyout = mode === "flyout";
  const [activeKeys, setActiveKeys] = useState<string[]>([]);
  const [featureDetailsOpen, setFeatureDetailsOpen] = useState(false);
  const collapseHeaderRefs = useRef<Record<string, HTMLSpanElement | null>>({});
  const featureDetailsRef = useRef<HTMLDivElement | null>(null);
  const { env } = useProjectEnv(project_id);
  const { secrets } = useProjectSecrets(project_id);
  const { rootfs } = useProjectRootfs(project_id);
  const { images: rootfsImages } = useRootfsImages([managedRootfsCatalogUrl()]);
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
  const runtimeImage = rootfsLabel(rootfs, rootfsImages);
  const networkSummary = runQuota?.network ? "Internet enabled" : "Restricted";
  const memberHost = runQuota?.member_host ? "member host" : undefined;

  function scrollToElement(element: HTMLElement | null): void {
    if (element == null) return;
    const scroll = () =>
      element.scrollIntoView?.({ behavior: "smooth", block: "start" });
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => requestAnimationFrame(scroll));
    } else {
      setTimeout(scroll, 0);
    }
  }

  function expand(key: string): void {
    setActiveKeys((keys) => (keys.includes(key) ? keys : [...keys, key]));
    scrollToElement(collapseHeaderRefs.current[key]);
  }

  function collapseLabel(key: string, label: ReactNode): ReactNode {
    return (
      <span
        ref={(node) => {
          collapseHeaderRefs.current[key] = node;
        }}
      >
        {label}
      </span>
    );
  }

  function renderAction(key: string, label = "Details") {
    return (
      <Button size="small" type="link" onClick={() => expand(key)}>
        {label}
      </Button>
    );
  }

  function renderFeatureAction() {
    return (
      <Button
        size="small"
        type="link"
        onClick={() => {
          setFeatureDetailsOpen(true);
          scrollToElement(featureDetailsRef.current);
        }}
      >
        Details
      </Button>
    );
  }

  const summaryColumns = isFlyout ? "1fr" : "repeat(3, minmax(0, 1fr))";

  const detailMode: Mode = "flyout";
  const SummaryComponent = isFlyout ? SummaryRow : SummaryCard;
  const summaryItems: SummaryCardProps[] = [
    {
      icon: "disk-drive",
      title: "Runtime Image",
      value: runtimeImage,
      subtitle: "Base software environment",
      action: renderAction("runtime-image"),
    },
    {
      icon: "clipboard-check",
      title: "Available Features",
      value: configurationLoading
        ? "Refreshing..."
        : `${features.availableCount} features`,
      subtitle: features.formatterCount
        ? `${features.formatterCount} formatter${features.formatterCount === 1 ? "" : "s"}`
        : "Feature probe",
      action: renderFeatureAction(),
    },
    {
      icon: "bars",
      title: "Environment Variables",
      value: `${envCount} configured`,
      subtitle: "Custom process environment",
      action: renderAction("configuration", "Configure"),
    },
    {
      icon: "key",
      title: "Project Secrets",
      value: `${secretCount} secret${secretCount === 1 ? "" : "s"}`,
      subtitle: "Mounted encrypted files",
      action: renderAction("configuration", "Configure"),
    },
    {
      icon: "network",
      title: "Network",
      value: networkSummary,
      subtitle: memberHost ?? "Project access",
    },
    {
      icon: "terminal",
      title: "SSH",
      value: lite ? "Unavailable" : "Available",
      subtitle: hostId ? `Host ${hostId.slice(0, 8)}` : "Remote access",
    },
  ];

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
          ...(isFlyout
            ? {
                background: "white",
                border: `1px solid ${COLORS.GRAY_LL}`,
                borderRadius: 10,
                padding: "0 10px",
              }
            : {}),
        }}
      >
        {summaryItems.map((item, index) => (
          <SummaryComponent
            key={`${item.title}`}
            {...item}
            isLast={index === summaryItems.length - 1}
          />
        ))}
      </div>

      <div ref={featureDetailsRef}>
        <EnvironmentFeatureGroups
          expanded={featureDetailsOpen}
          mode={mode}
          onDetails={() => expand("diagnostics")}
          onExpandedChange={setFeatureDetailsOpen}
          project_id={project_id}
        />
      </div>

      <Collapse
        activeKey={activeKeys}
        onChange={(keys) =>
          setActiveKeys(Array.isArray(keys) ? keys.map(String) : [String(keys)])
        }
        items={[
          {
            key: "configuration",
            label: collapseLabel("configuration", "Configuration"),
            children: (
              <Space direction="vertical" size={12} style={{ width: "100%" }}>
                <Typography.Text type="secondary">
                  Launcher defaults, process environment, and mounted secrets.
                </Typography.Text>
                <LauncherDefaults project_id={project_id} />
                <CustomEnvironmentVariables
                  project_id={project_id}
                  mode={detailMode}
                />
                <ProjectSecrets project_id={project_id} mode={detailMode} />
              </Space>
            ),
          },
          {
            key: "runtime-image",
            label: collapseLabel("runtime-image", "Runtime Image"),
            children: <RootFilesystemImage />,
          },
          {
            key: "diagnostics",
            label: collapseLabel("diagnostics", "Technical Details"),
            children: (
              <Space direction="vertical" size={12} style={{ width: "100%" }}>
                <Typography.Text type="secondary">
                  Full feature probe output and formatter details for debugging
                  or support.
                </Typography.Text>
                <ProjectCapabilities
                  project={project}
                  project_id={project_id}
                  mode={detailMode}
                />
              </Space>
            ),
          },
        ]}
      />
    </Space>
  );
}
