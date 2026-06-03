/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Card, Space, Typography } from "antd";
import { useEffect, useState } from "react";
import { defineMessage } from "react-intl";

import api from "@cocalc/frontend/client/api";
import { Icon, Loading } from "@cocalc/frontend/components";
import type { IconName } from "@cocalc/frontend/components/icon";
import { labels } from "@cocalc/frontend/i18n";
import type { SettingsPageDefinition } from "../settings-page";
import { openAccountSettings } from "../settings-routing";
import { MembershipPackageManager } from "../membership-package-manager";
import type { MembershipTierWithPresentation } from "../membership-tier-benefits";
import { SoftwareLicensesPage } from "./software-licenses";

const { Paragraph, Title } = Typography;

export const LICENSES_SETTINGS_PAGE = {
  component: LicensesOverviewPage,
  description: defineMessage({
    id: "account.settings.overview.licenses",
    defaultMessage: "Find team, site, and software license management.",
  }),
  icon: "key",
  key: "licenses",
  label: labels.overview,
} satisfies SettingsPageDefinition;

export const TEAM_LICENSES_SETTINGS_PAGE = {
  component: TeamLicensesPage,
  description: defineMessage({
    id: "account.settings.overview.team_licenses",
    defaultMessage: "Buy team seats and assign memberships to people.",
  }),
  icon: "users",
  key: "team-licenses",
  label: labels.team_licenses,
} satisfies SettingsPageDefinition;

export const SITE_LICENSES_SETTINGS_PAGE = {
  component: SiteLicensesPage,
  description: defineMessage({
    id: "account.settings.overview.site_licenses",
    defaultMessage:
      "Manage institutional license requests, seats, and managers.",
  }),
  icon: "graduation-cap",
  key: "site-licenses",
  label: labels.site_licenses,
} satisfies SettingsPageDefinition;

export const SOFTWARE_LICENSES_SETTINGS_PAGE = {
  component: SoftwareLicensesPage,
  description: defineMessage({
    id: "account.settings.overview.software_licenses",
    defaultMessage: "Manage Launchpad/Rocket software license tokens.",
  }),
  icon: "key",
  key: "software-licenses",
  label: labels.software_licenses,
} satisfies SettingsPageDefinition;

interface MembershipTier extends MembershipTierWithPresentation {
  id: string;
  label?: string;
  store_visible?: boolean;
  priority?: number;
  price_monthly?: number;
  price_yearly?: number;
  project_defaults?: Record<string, unknown>;
  ai_limits?: Record<string, unknown>;
  features?: Record<string, unknown>;
  usage_limits?: Record<string, unknown>;
  disabled?: boolean;
}

interface MembershipTiersResponse {
  tiers?: MembershipTier[];
}

function LicenseManagementPage({
  description,
  mode,
}: {
  description: string;
  mode: "site" | "team";
}) {
  const [tiers, setTiers] = useState<MembershipTier[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");
  const [refreshToken, setRefreshToken] = useState<number>(0);

  useEffect(() => {
    let canceled = false;
    async function loadTiers() {
      setLoading(true);
      setError("");
      try {
        const result = (await api(
          "purchases/get-membership-tiers",
        )) as MembershipTiersResponse;
        if (!canceled) {
          setTiers(result?.tiers ?? []);
        }
      } catch (err) {
        if (!canceled) {
          setError(`${err}`);
          setTiers([]);
        }
      } finally {
        if (!canceled) {
          setLoading(false);
        }
      }
    }
    void loadTiers();
    return () => {
      canceled = true;
    };
  }, [refreshToken]);

  function handleChanged() {
    setRefreshToken((value) => value + 1);
  }

  return (
    <Space orientation="vertical" size="large" style={{ width: "100%" }}>
      <Paragraph type="secondary" style={{ marginBottom: 0, maxWidth: 760 }}>
        {description}
      </Paragraph>

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
        <MembershipPackageManager
          mode={mode}
          tiers={tiers}
          onChanged={handleChanged}
        />
      )}
    </Space>
  );
}

function TeamLicensesPage() {
  return (
    <LicenseManagementPage
      mode="team"
      description="Buy team seats and assign them to the CoCalc accounts that should receive membership access."
    />
  );
}

function SiteLicensesPage() {
  return (
    <LicenseManagementPage
      mode="site"
      description="Manage site licenses where you are an owner or manager: review requests, manage seats, and update managers."
    />
  );
}

function LicensesOverviewPage() {
  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Paragraph type="secondary">
        Licenses here are multi-user grants or software entitlements that you
        administer. To claim your own site-license membership, use the
        Membership page.
      </Paragraph>
      <Space
        direction="horizontal"
        wrap
        size="middle"
        style={{ width: "100%" }}
      >
        <LicenseOverviewCard
          icon="users"
          title="Team Licenses"
          description="Buy and assign membership seats for a team."
          page="team-licenses"
        />
        <LicenseOverviewCard
          icon="graduation-cap"
          title="Site Licenses"
          description="Manage institutional license requests, seats, and managers."
          page="site-licenses"
        />
        <LicenseOverviewCard
          icon="key"
          title="Software Licenses"
          description="Manage Launchpad/Rocket license tokens."
          page="software-licenses"
        />
      </Space>
    </Space>
  );
}

function LicenseOverviewCard({
  description,
  icon,
  page,
  title,
}: {
  description: string;
  icon: IconName;
  page: "site-licenses" | "software-licenses" | "team-licenses";
  title: string;
}) {
  return (
    <Card
      hoverable
      style={{ maxWidth: 340, minWidth: 260 }}
      onClick={() => {
        openAccountSettings({ page });
      }}
    >
      <Space orientation="vertical" size="small">
        <Title level={4} style={{ margin: 0 }}>
          <Icon name={icon} /> {title}
        </Title>
        <Paragraph type="secondary" style={{ margin: 0 }}>
          {description}
        </Paragraph>
      </Space>
    </Card>
  );
}
