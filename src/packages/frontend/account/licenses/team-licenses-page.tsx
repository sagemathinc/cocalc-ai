/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Space } from "antd";
import { lazy, Suspense } from "react";
import { defineMessage } from "react-intl";

import { Loading } from "@cocalc/frontend/components";
import { labels } from "@cocalc/frontend/i18n";
import { useMembershipTiers } from "../membership-tiers";
import type { SettingsPageDefinition } from "../settings-page";

const TeamPackageManager = lazy(async () => ({
  default: (await import("../membership-package-manager")).TeamPackageManager,
}));

export const TEAM_LICENSES_SETTINGS_PAGE = {
  component: TeamLicensesPage,
  description: defineMessage({
    id: "account.settings.overview.team_licenses",
    defaultMessage: "Create a team license and assign seats to people.",
  }),
  icon: "users",
  key: "team-licenses",
  label: labels.team,
  title: defineMessage({
    id: "account.settings.team_licenses.title",
    defaultMessage: "Team License",
  }),
} satisfies SettingsPageDefinition;

function TeamLicensesPage() {
  const { error, loading, refresh, tiers } = useMembershipTiers();

  return (
    <Space orientation="vertical" size="large" style={{ width: "100%" }}>
      {error ? (
        <Alert
          type="error"
          showIcon
          title="Could not load membership tiers"
          description={error}
        />
      ) : null}

      {loading ? (
        <Loading />
      ) : (
        <Suspense fallback={<Loading />}>
          <TeamPackageManager tiers={tiers} onChanged={refresh} />
        </Suspense>
      )}
    </Space>
  );
}
