/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert } from "antd";
import { lazy, Suspense } from "react";
import { defineMessage } from "react-intl";

import { Loading } from "@cocalc/frontend/components";
import { labels } from "@cocalc/frontend/i18n";
import { useMembershipTiers } from "../membership-tiers";
import type { SettingsPageDefinition } from "../settings-page";

const SiteLicenseManager = lazy(async () => ({
  default: (await import("../membership-package-manager")).SiteLicenseManager,
}));

export const SITE_LICENSES_SETTINGS_PAGE = {
  component: SiteLicensesPage,
  description: defineMessage({
    id: "account.settings.overview.site_licenses",
    defaultMessage:
      "Manage institutional license requests, seats, and managers.",
  }),
  icon: "graduation-cap",
  key: "site-licenses",
  label: labels.site,
  title: defineMessage({
    id: "account.settings.site_licenses.title",
    defaultMessage: "Site License",
  }),
} satisfies SettingsPageDefinition;

function SiteLicensesPage() {
  const { error, loading, refresh, tiers } = useMembershipTiers();

  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        title="Could not load membership tiers"
        description={error}
      />
    );
  }

  if (loading) {
    return <Loading />;
  }

  return (
    <Suspense fallback={<Loading />}>
      <SiteLicenseManager tiers={tiers} onChanged={refresh} />
    </Suspense>
  );
}
