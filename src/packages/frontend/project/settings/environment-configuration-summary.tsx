/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Card, Space, Tag, Typography } from "antd";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

import {
  redux,
  useAccountOtherSetting,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { file_options } from "@cocalc/frontend/editor-tmp";
import {
  acknowledgeDocsAction,
  PROJECT_SECRETS_DOCS_ACTION_EVENT,
  type ProjectSecretsDocsActionDetail,
} from "@cocalc/frontend/project/docs-actions";
import { useProjectEnv } from "@cocalc/frontend/project/use-project-env";
import { useProjectSecrets } from "@cocalc/frontend/project/use-project-secrets";
import { COLORS } from "@cocalc/util/theme";

import { LauncherCustomizeModal } from "../new/launcher-customize-modal";
import {
  getAccountLauncherPrefs,
  getEffectiveLauncher,
  getSiteLauncherDefaults,
  LAUNCHER_SETTINGS_KEY,
  LAUNCHER_SITE_DEFAULTS_QUICK_KEY,
  updateAccountLauncherPrefs,
} from "../new/launcher-preferences";
import { QUICK_CREATE_MAP } from "../new/launcher-catalog";
import { EnvironmentVariablesModal } from "./environment";
import { ProjectSecretsModal } from "./secrets";

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
  const [showLauncherModal, setShowLauncherModal] = useState(false);
  const [showEnvModal, setShowEnvModal] = useState(false);
  const [showSecretsModal, setShowSecretsModal] = useState(false);
  const siteLauncherQuick = useTypedRedux(
    "customize",
    LAUNCHER_SITE_DEFAULTS_QUICK_KEY,
  );
  const launcherSettings = useAccountOtherSetting(LAUNCHER_SETTINGS_KEY);
  const { env } = useProjectEnv(project_id);
  const { secrets } = useProjectSecrets(project_id);

  const siteLauncherDefaults = useMemo(
    () => getSiteLauncherDefaults(siteLauncherQuick),
    [siteLauncherQuick],
  );
  const accountLauncherPrefs = useMemo(
    () => getAccountLauncherPrefs(launcherSettings),
    [launcherSettings],
  );
  const launcherDefaults = useMemo(
    () =>
      getEffectiveLauncher({
        accountPrefs: accountLauncherPrefs,
        siteDefaults: siteLauncherDefaults,
      }).quickCreate,
    [accountLauncherPrefs, siteLauncherDefaults],
  );
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

  useEffect(() => {
    const handleReveal = (event: Event) => {
      const detail = (event as CustomEvent<ProjectSecretsDocsActionDetail>)
        .detail;
      if (detail?.projectId !== project_id) return;
      if (detail?.surface != null && detail.surface !== mode) return;
      setShowSecretsModal(true);
      if (detail.requestId) {
        acknowledgeDocsAction({
          actionId: "settings.environment.secrets",
          projectId: project_id,
          requestId: detail.requestId,
        });
      }
    };
    window.addEventListener(PROJECT_SECRETS_DOCS_ACTION_EVENT, handleReveal);
    return () => {
      window.removeEventListener(
        PROJECT_SECRETS_DOCS_ACTION_EVENT,
        handleReveal,
      );
    };
  }, [mode, project_id]);

  function saveLauncherDefaults(prefs: any | null): void {
    const next = updateAccountLauncherPrefs(launcherSettings, prefs);
    redux.getActions("account").set_other_settings(LAUNCHER_SETTINGS_KEY, next);
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
          subtitle="Your Quick Create buttons"
          status={`${launcherDefaults.length} default${launcherDefaults.length === 1 ? "" : "s"}`}
          action={
            <Button
              size="small"
              type="link"
              onClick={() => setShowLauncherModal(true)}
            >
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
            <Button
              size="small"
              type="link"
              onClick={() => setShowEnvModal(true)}
            >
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
            <Button
              data-cocalc-docs-action="settings.environment.secrets"
              size="small"
              type="link"
              onClick={() => setShowSecretsModal(true)}
            >
              Manage
            </Button>
          }
        >
          {renderTags(secretNames, "No project secrets configured.")}
        </ConfigurationCard>
      </div>

      <LauncherCustomizeModal
        open={showLauncherModal}
        onClose={() => setShowLauncherModal(false)}
        initialQuickCreate={launcherDefaults}
        onSave={saveLauncherDefaults}
      />

      <EnvironmentVariablesModal
        open={showEnvModal}
        onClose={() => setShowEnvModal(false)}
        project_id={project_id}
      />
      <ProjectSecretsModal
        open={showSecretsModal}
        onClose={() => setShowSecretsModal(false)}
        project_id={project_id}
      />
    </Space>
  );
}
