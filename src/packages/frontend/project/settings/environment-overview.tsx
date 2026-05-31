/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Card, Collapse, Space, Tag, Typography } from "antd";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { useProjectEnv } from "@cocalc/frontend/project/use-project-env";
import { useProjectRootfs } from "@cocalc/frontend/project/use-project-rootfs";
import { useProjectSecrets } from "@cocalc/frontend/project/use-project-secrets";
import {
  acknowledgeDocsAction,
  RUNTIME_IMAGE_DOCS_ACTION_EVENT,
  type RuntimeImageDocsActionDetail,
} from "@cocalc/frontend/project/docs-actions";
import {
  managedRootfsCatalogUrl,
  useRootfsImages,
} from "@cocalc/frontend/rootfs/manifest";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { PROJECT_CAPABILITY_SPECS } from "@cocalc/util/project-capabilities";
import {
  PROJECT_STARTUP_ERR_PATH,
  PROJECT_STARTUP_LOG_PATH,
  PROJECT_STARTUP_SCRIPT_PATH,
  PROJECT_STARTUP_SCRIPT_TEMPLATE,
} from "@cocalc/util/project-startup-script";
import { COLORS } from "@cocalc/util/theme";

import { EnvironmentConfigurationSummary } from "./environment-configuration-summary";
import { EnvironmentFeatureGroups } from "./environment-feature-groups";
import { ProjectCapabilities } from "./project-capabilites";
import { RootFilesystemImageModal } from "./root-filesystem-image";
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
      style={{
        borderColor: COLORS.GRAY_LL,
        height: "100%",
        position: "relative",
      }}
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
          <Typography.Text
            type="secondary"
            style={{
              display: "block",
              fontSize: 12,
              marginRight: action == null ? undefined : 52,
            }}
          >
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
      </div>
      {action != null ? (
        <div style={{ position: "absolute", right: 8, top: 6 }}>{action}</div>
      ) : undefined}
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
        alignItems: "start",
        borderBottom: isLast ? undefined : `1px solid ${COLORS.GRAY_LL}`,
        gap: 8,
        padding: "8px 0",
      }}
    >
      <div
        style={{
          alignItems: "start",
          display: "grid",
          gap: 8,
          gridTemplateColumns: "24px minmax(0, 1fr)",
        }}
      >
        <Icon
          name={icon as any}
          style={{ color: COLORS.ANTD_LINK_BLUE, fontSize: 15, marginTop: 2 }}
        />
        <div
          style={{
            minWidth: 0,
          }}
        >
          <div
            style={{
              alignItems: "center",
              display: "grid",
              gap: 8,
              gridTemplateColumns: "minmax(0, 1fr) auto",
            }}
          >
            <Typography.Text
              type="secondary"
              style={{
                display: "block",
                fontSize: 12,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {title}
            </Typography.Text>
            {action != null ? (
              <div style={{ minWidth: "fit-content" }}>{action}</div>
            ) : undefined}
          </div>
          <div style={{ minWidth: 0 }}>
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
              <div style={{ color: COLORS.GRAY_M, fontSize: 12 }}>
                {subtitle}
              </div>
            ) : undefined}
          </div>
        </div>
      </div>
    </div>
  );
}

function EnvironmentStatusHeader({
  envCount,
  featureCount,
  runtimeImage,
  secretCount,
}: {
  envCount: number;
  featureCount: number;
  runtimeImage: string;
  secretCount: number;
}) {
  return (
    <div
      style={{
        background: `linear-gradient(135deg, ${COLORS.ANTD_BG_BLUE_L}, white)`,
        border: `1px solid ${COLORS.GRAY_LL}`,
        borderRadius: 10,
        padding: "10px 12px",
      }}
    >
      <Space align="start" size={10} style={{ width: "100%" }}>
        <div
          style={{
            alignItems: "center",
            background: "white",
            borderRadius: 8,
            color: COLORS.ANTD_LINK_BLUE,
            display: "flex",
            flex: "0 0 auto",
            height: 34,
            justifyContent: "center",
            width: 34,
          }}
        >
          <Icon name="terminal" />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <Typography.Text strong>Environment</Typography.Text>
          <div
            style={{
              color: COLORS.GRAY_D,
              fontSize: 12,
              overflowWrap: "anywhere",
              wordBreak: "break-word",
            }}
            title={runtimeImage}
          >
            Runtime image: {runtimeImage}
          </div>
          <Space size={[6, 6]} wrap style={{ marginTop: 6 }}>
            <Tag color="blue" style={{ marginInlineEnd: 0 }}>
              {featureCount} features
            </Tag>
            <Tag style={{ marginInlineEnd: 0 }}>
              {envCount} env var{envCount === 1 ? "" : "s"}
            </Tag>
            <Tag style={{ marginInlineEnd: 0 }}>
              {secretCount} secret{secretCount === 1 ? "" : "s"}
            </Tag>
          </Space>
        </div>
      </Space>
    </div>
  );
}

function StartupScriptCard({ project_id }: { project_id: string }) {
  const startupScriptDirectory = PROJECT_STARTUP_SCRIPT_PATH.split("/")
    .slice(0, -1)
    .join("/");

  function openFile(path: string): void {
    redux.getProjectActions(project_id).open_file({ path });
  }

  async function writeStartupTemplate(): Promise<void> {
    await webapp_client.project_client.exec({
      project_id,
      command: "mkdir",
      args: ["-p", startupScriptDirectory],
      err_on_exit: true,
    });
    await webapp_client.project_client.write_text_file({
      project_id,
      path: PROJECT_STARTUP_SCRIPT_PATH,
      content: PROJECT_STARTUP_SCRIPT_TEMPLATE,
    });
  }

  async function openStartupScript(): Promise<void> {
    try {
      const content = await webapp_client.project_client.read_text_file({
        project_id,
        path: PROJECT_STARTUP_SCRIPT_PATH,
      });
      if (content.trim() === "") {
        await writeStartupTemplate();
      }
    } catch {
      await writeStartupTemplate();
    }
    openFile(PROJECT_STARTUP_SCRIPT_PATH);
  }

  return (
    <Card
      size="small"
      style={{
        borderColor: COLORS.GRAY_LL,
      }}
      styles={{ body: CARD_BODY_STYLE }}
    >
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        <Space align="start" size={10} style={{ width: "100%" }}>
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
            <Icon name="terminal" />
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <Typography.Text strong>Startup Script</Typography.Text>
            <Typography.Paragraph
              type="secondary"
              style={{ fontSize: 12, margin: "2px 0 0" }}
            >
              Run setup commands each time this project starts after idle
              shutdown, maintenance, or restart.
            </Typography.Paragraph>
          </div>
        </Space>
        <Typography.Text code copyable style={{ fontSize: 12 }}>
          ~/{PROJECT_STARTUP_SCRIPT_PATH}
        </Typography.Text>
        <Space size={[8, 8]} wrap>
          <Button
            size="small"
            type="primary"
            onClick={() => void openStartupScript()}
          >
            Open Startup Script
          </Button>
          <Button
            size="small"
            onClick={() => openFile(PROJECT_STARTUP_LOG_PATH)}
          >
            Open Log
          </Button>
          <Button
            size="small"
            onClick={() => openFile(PROJECT_STARTUP_ERR_PATH)}
          >
            Open Errors
          </Button>
        </Space>
      </Space>
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
  const [activeDetailKeys, setActiveDetailKeys] = useState<string[]>([]);
  const [featureDetailsOpen, setFeatureDetailsOpen] = useState(false);
  const [runtimeImageOpen, setRuntimeImageOpen] = useState(false);
  const collapseHeaderRefs = useRef<Record<string, HTMLSpanElement | null>>({});
  const featureDetailsRef = useRef<HTMLDivElement | null>(null);
  const { env } = useProjectEnv(project_id);
  const { secrets } = useProjectSecrets(project_id);
  const { rootfs } = useProjectRootfs(project_id);
  const { images: rootfsImages } = useRootfsImages([managedRootfsCatalogUrl()]);
  const availableFeatures = useTypedRedux({ project_id }, "available_features");
  const configurationLoading = useTypedRedux(
    { project_id },
    "configuration_loading",
  );
  const avail = availableFeatures?.toJS?.();
  const features = useMemo(() => featureSummary(avail), [avail]);
  const envCount = countConfiguredEnv(env);
  const secretCount = secrets?.length ?? 0;
  const runtimeImage = rootfsLabel(rootfs, rootfsImages);

  useEffect(() => {
    function handleReveal(event: Event): void {
      const detail = (event as CustomEvent<RuntimeImageDocsActionDetail>)
        .detail;
      if (detail?.projectId !== project_id) return;
      if (detail?.surface != null && detail.surface !== mode) return;
      setRuntimeImageOpen(true);
      if (detail.requestId) {
        acknowledgeDocsAction({
          actionId: "settings.runtime.rootfs",
          projectId: project_id,
          requestId: detail.requestId,
        });
      }
    }
    window.addEventListener(RUNTIME_IMAGE_DOCS_ACTION_EVENT, handleReveal);
    return () => {
      window.removeEventListener(RUNTIME_IMAGE_DOCS_ACTION_EVENT, handleReveal);
    };
  }, [mode, project_id]);

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

  function addActiveKey(
    setter: (fn: (keys: string[]) => string[]) => void,
    key: string,
  ): void {
    setter((keys) => (keys.includes(key) ? keys : [...keys, key]));
  }

  function openDetail(key: string): void {
    if (isFlyout) {
      addActiveKey(setActiveKeys, "more");
      addActiveKey(setActiveDetailKeys, key);
      scrollToElement(collapseHeaderRefs.current.more);
      return;
    }
    addActiveKey(setActiveKeys, key);
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

  const summaryColumns = isFlyout
    ? "1fr"
    : "repeat(auto-fit, minmax(220px, 1fr))";

  const detailMode: Mode = "flyout";
  const SummaryComponent = isFlyout ? SummaryRow : SummaryCard;
  const detailItems = [
    {
      key: "diagnostics",
      label: isFlyout
        ? "Technical Details"
        : collapseLabel("diagnostics", "Technical Details"),
      children: (
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            Full feature probe output and formatter details for debugging or
            support.
          </Typography.Text>
          <ProjectCapabilities
            project={project}
            project_id={project_id}
            mode={detailMode}
          />
        </Space>
      ),
    },
  ];
  const collapseItems = isFlyout
    ? [
        {
          key: "more",
          label: collapseLabel("more", "More environment details"),
          children: (
            <Collapse
              activeKey={activeDetailKeys}
              onChange={(keys) =>
                setActiveDetailKeys(
                  Array.isArray(keys) ? keys.map(String) : [String(keys)],
                )
              }
              items={detailItems}
              size="small"
            />
          ),
        },
      ]
    : detailItems;
  const summaryItems: SummaryCardProps[] = [
    {
      icon: "disk-drive",
      title: "Runtime Image",
      value: runtimeImage,
      subtitle: "Base software environment",
      action: (
        <Button
          size="small"
          type="link"
          onClick={() => setRuntimeImageOpen(true)}
        >
          Details
        </Button>
      ),
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
  ];

  return (
    <Space
      direction="vertical"
      size={isFlyout ? 10 : 14}
      style={{ width: "100%" }}
    >
      {isFlyout ? (
        <EnvironmentStatusHeader
          envCount={envCount}
          featureCount={features.availableCount}
          runtimeImage={runtimeImage}
          secretCount={secretCount}
        />
      ) : null}
      <EnvironmentConfigurationSummary mode={mode} project_id={project_id} />
      <StartupScriptCard project_id={project_id} />
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
          onDetails={() => openDetail("diagnostics")}
          onExpandedChange={setFeatureDetailsOpen}
          project_id={project_id}
        />
      </div>

      <Collapse
        activeKey={activeKeys}
        onChange={(keys) =>
          setActiveKeys(Array.isArray(keys) ? keys.map(String) : [String(keys)])
        }
        items={collapseItems}
      />
      <RootFilesystemImageModal
        open={runtimeImageOpen}
        onClose={() => setRuntimeImageOpen(false)}
      />
    </Space>
  );
}
