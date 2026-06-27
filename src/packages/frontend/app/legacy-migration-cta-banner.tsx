/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Space, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";

import { openAccountSettings } from "@cocalc/frontend/account/settings-routing";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import * as LS from "@cocalc/frontend/misc/local-storage-typed";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type {
  LegacyMigrationFinancialPreviewResponse,
  LegacyMigrationProjectSummary,
} from "@cocalc/conat/hub/api/legacy-migration";

const { Text } = Typography;

const REFRESH_MS = 15 * 60 * 1000;
const DISMISS_MS = 7 * 24 * 60 * 60 * 1000;
const PROJECT_CHECK_LIMIT = 1000;
const DISMISSED_KEY_PREFIX = "legacy-migration-cta-dismissed";

type MigrationCtaState = {
  financialApply: boolean;
  financialContinue: boolean;
  financialMembershipClass?: string | null;
  projectActionCount: number;
};

function archiveAvailable(project: LegacyMigrationProjectSummary): boolean {
  return (
    project.artifact_status === "available" &&
    !!project.artifact_key &&
    typeof project.artifact_bytes === "number" &&
    Number.isFinite(project.artifact_bytes)
  );
}

function projectNeedsAction(project: LegacyMigrationProjectSummary): boolean {
  if (!project.project_id) {
    return archiveAvailable(project);
  }
  return (
    !project.joined ||
    project.restore_status === "failed" ||
    project.restore_status === "selection-pending"
  );
}

function membershipLabel(value: string | null | undefined): string {
  if (!value) return "membership";
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)} membership`;
}

function financialState(
  preview: LegacyMigrationFinancialPreviewResponse | undefined,
): Pick<
  MigrationCtaState,
  "financialApply" | "financialContinue" | "financialMembershipClass"
> {
  if (!preview) {
    return {
      financialApply: false,
      financialContinue: false,
      financialMembershipClass: null,
    };
  }
  const financialApply = preview.can_apply;
  const financialContinue =
    !financialApply &&
    !!preview.applied_membership_class &&
    !preview.membership_renewal_configured;
  return {
    financialApply,
    financialContinue,
    financialMembershipClass: preview.applied_membership_class,
  };
}

function workKey(state: MigrationCtaState | null): string | undefined {
  if (!state) return;
  const reasons: string[] = [];
  if (state.financialApply) reasons.push("financial-apply");
  if (state.financialContinue) reasons.push("financial-continue");
  if (state.projectActionCount > 0) reasons.push("projects");
  return reasons.length > 0 ? reasons.join("|") : undefined;
}

function isDismissed(account_id: string, key: string): boolean {
  const dismissedAt = LS.get<number>([DISMISSED_KEY_PREFIX, account_id, key]);
  return (
    typeof dismissedAt === "number" && Date.now() < dismissedAt + DISMISS_MS
  );
}

function dismiss(account_id: string, key: string): void {
  LS.set([DISMISSED_KEY_PREFIX, account_id, key], Date.now());
}

export function LegacyMigrationCtaBanner() {
  const account_id = useTypedRedux("account", "account_id");
  const is_logged_in = useTypedRedux("account", "is_logged_in");
  const legacyMigrationEnabled = !!useTypedRedux(
    "customize",
    "legacy_migration_enabled",
  );
  const [state, setState] = useState<MigrationCtaState | null>(null);
  const [dismissedKey, setDismissedKey] = useState<string | undefined>();

  useEffect(() => {
    if (!is_logged_in || !account_id || !legacyMigrationEnabled) {
      setState(null);
      return;
    }
    let canceled = false;

    async function load() {
      const [financial, projects] = await Promise.allSettled([
        webapp_client.conat_client.hub.legacyMigration.previewFinancialMigration(),
        webapp_client.conat_client.hub.legacyMigration.listProjects({
          include_hidden: false,
          limit: PROJECT_CHECK_LIMIT,
        }),
      ]);
      if (canceled) return;

      const preview =
        financial.status === "fulfilled" ? financial.value : undefined;
      const projectActionCount =
        projects.status === "fulfilled"
          ? projects.value.projects.filter(projectNeedsAction).length
          : 0;
      setState({
        ...financialState(preview),
        projectActionCount,
      });
    }

    void load();
    const interval = setInterval(() => void load(), REFRESH_MS);
    return () => {
      canceled = true;
      clearInterval(interval);
    };
  }, [account_id, is_logged_in, legacyMigrationEnabled]);

  const key = workKey(state);
  const dismissed = useMemo(
    () =>
      !!account_id &&
      !!key &&
      (dismissedKey === key || isDismissed(account_id, key)),
    [account_id, dismissedKey, key],
  );

  if (!account_id || !state || !key || dismissed) {
    return null;
  }

  const showBilling = state.financialApply || state.financialContinue;
  const showProjects = state.projectActionCount > 0;
  const message = state.financialContinue
    ? `Your free legacy ${membershipLabel(
        state.financialMembershipClass,
      )} is active`
    : "Finish your cocalc.com migration";
  const description = state.financialContinue
    ? "Set up renewal now if you want to keep it. Your paid membership starts after the free migration month."
    : showBilling && showProjects
      ? "Claim legacy billing credit, start your free migration membership, and restore legacy projects."
      : showBilling
        ? "Claim legacy billing credit and start your free 30-day migration membership."
        : showProjects
          ? "Restore legacy cocalc.com projects that are ready to import."
          : "";

  return (
    <Alert
      type="info"
      showIcon
      banner
      closable
      style={{ marginBottom: "10px", paddingBlock: "6px" }}
      onClose={() => {
        dismiss(account_id, key);
        setDismissedKey(key);
      }}
      message={
        <div
          style={{
            alignItems: "center",
            display: "flex",
            flexWrap: "wrap",
            gap: "12px",
            justifyContent: "space-between",
            width: "100%",
          }}
        >
          <Space size="small" wrap>
            <Icon name="exchange" />
            <strong>{message}</strong>
            <Text type="secondary">{description}</Text>
          </Space>
          <Space size="small" wrap>
            {showBilling ? (
              <Button
                size="small"
                type={showProjects ? "default" : "primary"}
                onClick={() => openAccountSettings({ page: "balance" })}
              >
                {state.financialContinue
                  ? "Continue membership"
                  : "Review billing migration"}
              </Button>
            ) : null}
            {showProjects ? (
              <Button
                size="small"
                type="primary"
                onClick={() =>
                  openAccountSettings({ page: "legacy-migration" })
                }
              >
                Restore projects
              </Button>
            ) : null}
          </Space>
        </div>
      }
    />
  );
}
