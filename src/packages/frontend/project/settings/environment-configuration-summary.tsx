/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Card, Collapse, Space, Tag, Typography } from "antd";
import type { ReactNode } from "react";
import { useMemo, useRef, useState } from "react";

import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { file_options } from "@cocalc/frontend/editor-tmp";
import { useProjectEnv } from "@cocalc/frontend/project/use-project-env";
import { useProjectLauncher } from "@cocalc/frontend/project/use-project-launcher";
import { useProjectSecrets } from "@cocalc/frontend/project/use-project-secrets";
import { COLORS } from "@cocalc/util/theme";

import {
  getProjectLauncherDefaults,
  getSiteLauncherDefaults,
  LAUNCHER_SITE_DEFAULTS_QUICK_KEY,
  LAUNCHER_SITE_REMOVE_QUICK_KEY,
  mergeLauncherSettings,
} from "../new/launcher-preferences";
import { QUICK_CREATE_MAP } from "../new/launcher-catalog";
import { Environment as CustomEnvironmentVariables } from "./environment";
import { LauncherDefaults } from "./launcher-defaults";
import { ProjectSecrets } from "./secrets";

type Mode = "project" | "flyout";

interface Props {
  mode?: Mode;
  project_id: string;
}

interface ConfigurationCardProps {
  action: ReactNode;
  icon: string;
  status: ReactNode;
  subtitle: ReactNode;
  title: ReactNode;
  children: ReactNode;
}

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

function ConfigurationCard({
  action,
  children,
  icon,
  status,
  subtitle,
  title,
}: ConfigurationCardProps) {
  return (
    <Card
      size="small"
      style={{ borderColor: COLORS.GRAY_LL, height: "100%" }}
      styles={{ body: { padding: 12 } }}
    >
      <Space direction="vertical" size={10} style={{ width: "100%" }}>
        <div
          style={{
            alignItems: "flex-start",
            display: "grid",
            gap: 10,
            gridTemplateColumns: "32px minmax(0, 1fr) auto",
          }}
        >
          <div
            style={{
              alignItems: "center",
              background: COLORS.ANTD_BG_BLUE_L,
              borderRadius: 8,
              color: COLORS.ANTD_LINK_BLUE,
              display: "flex",
              height: 32,
              justifyContent: "center",
              width: 32,
            }}
          >
            <Icon name={icon as any} />
          </div>
          <div style={{ minWidth: 0 }}>
            <Typography.Text strong>{title}</Typography.Text>
            <div style={{ color: COLORS.GRAY_M, fontSize: 12 }}>{subtitle}</div>
          </div>
          <div>{action}</div>
        </div>
        <div style={{ fontWeight: 600 }}>{status}</div>
        <div>{children}</div>
      </Space>
    </Card>
  );
}

export function EnvironmentConfigurationSummary({
  mode = "project",
  project_id,
}: Props) {
  const isFlyout = mode === "flyout";
  const [activeKeys, setActiveKeys] = useState<string[]>([]);
  const detailsRef = useRef<HTMLDivElement | null>(null);
  const siteLauncherQuick = useTypedRedux(
    "customize",
    LAUNCHER_SITE_DEFAULTS_QUICK_KEY,
  );
  const siteRemoveQuick = useTypedRedux(
    "customize",
    LAUNCHER_SITE_REMOVE_QUICK_KEY,
  );
  const { launcher } = useProjectLauncher(project_id);
  const { env } = useProjectEnv(project_id);
  const { secrets } = useProjectSecrets(project_id);

  const launcherDefaults = useMemo(() => {
    const siteDefaults = getSiteLauncherDefaults({
      hiddenQuickCreate: siteRemoveQuick,
      quickCreate: siteLauncherQuick,
    });
    const projectDefaults = getProjectLauncherDefaults(launcher);
    return mergeLauncherSettings({
      globalDefaults: siteDefaults,
      projectDefaults,
    }).quickCreate;
  }, [launcher, siteLauncherQuick, siteRemoveQuick]);
  const launcherLabels = useMemo(
    () =>
      launcherDefaults.map((id) => {
        const spec = QUICK_CREATE_MAP[id];
        if (spec != null) return spec.label;
        return file_options(`x.${id}`).name ?? id;
      }),
    [launcherDefaults],
  );
  const envKeys = useMemo(() => Object.keys(normalizeEnv(env)).sort(), [env]);
  const secretNames = useMemo(
    () => [...(secrets ?? [])].map((secret) => secret.name).sort(),
    [secrets],
  );

  function open(key: string): void {
    setActiveKeys((keys) => (keys.includes(key) ? keys : [...keys, key]));
    scrollToElement(detailsRef.current);
  }

  function renderTags(values: string[], empty: ReactNode, limit = 5) {
    if (values.length === 0) {
      return <Typography.Text type="secondary">{empty}</Typography.Text>;
    }
    return (
      <Space size={[6, 6]} wrap>
        {values.slice(0, limit).map((value) => (
          <Tag key={value} style={{ marginInlineEnd: 0 }}>
            {value}
          </Tag>
        ))}
        {values.length > limit ? (
          <Tag style={{ marginInlineEnd: 0 }}>+{values.length - limit}</Tag>
        ) : undefined}
      </Space>
    );
  }

  const detailMode: Mode = "flyout";

  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      <div
        style={{
          display: "grid",
          gap: 10,
          gridTemplateColumns: isFlyout
            ? "1fr"
            : "repeat(auto-fit, minmax(260px, 1fr))",
        }}
      >
        <ConfigurationCard
          icon="rocket"
          title="Launcher defaults"
          subtitle="Quick Create buttons for this project"
          status={`${launcherDefaults.length} default${launcherDefaults.length === 1 ? "" : "s"}`}
          action={
            <Button size="small" type="link" onClick={() => open("launcher")}>
              Edit
            </Button>
          }
        >
          {renderTags(launcherLabels, "No launcher defaults configured.")}
        </ConfigurationCard>
        <ConfigurationCard
          icon="bars"
          title="Environment variables"
          subtitle="Process environment for terminals and kernels"
          status={`${envKeys.length} variable${envKeys.length === 1 ? "" : "s"}`}
          action={
            <Button size="small" type="link" onClick={() => open("env")}>
              Manage
            </Button>
          }
        >
          {renderTags(envKeys, "No custom variables configured.")}
        </ConfigurationCard>
        <ConfigurationCard
          icon="key"
          title="Project secrets"
          subtitle="Encrypted files mounted into the project"
          status={`${secretNames.length} secret${secretNames.length === 1 ? "" : "s"}`}
          action={
            <Button size="small" type="link" onClick={() => open("secrets")}>
              Manage
            </Button>
          }
        >
          {renderTags(secretNames, "No project secrets configured.")}
        </ConfigurationCard>
      </div>

      <div ref={detailsRef}>
        {activeKeys.length > 0 ? (
          <Collapse
            activeKey={activeKeys}
            onChange={(keys) =>
              setActiveKeys(
                Array.isArray(keys) ? keys.map(String) : [String(keys)],
              )
            }
            items={[
              {
                key: "launcher",
                label: "Launcher defaults editor",
                children: <LauncherDefaults project_id={project_id} />,
              },
              {
                key: "env",
                label: "Environment variables editor",
                children: (
                  <CustomEnvironmentVariables
                    project_id={project_id}
                    mode={detailMode}
                  />
                ),
              },
              {
                key: "secrets",
                label: "Project secrets editor",
                children: (
                  <ProjectSecrets project_id={project_id} mode={detailMode} />
                ),
              },
            ]}
            size={isFlyout ? "small" : undefined}
          />
        ) : undefined}
      </div>
    </Space>
  );
}
