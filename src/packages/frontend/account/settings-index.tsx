/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Card, Divider, Flex } from "antd";
import { defineMessage, useIntl } from "react-intl";

import { redux } from "@cocalc/frontend/app-framework";
import { IS_MOBILE } from "@cocalc/frontend/feature";
import { labels } from "@cocalc/frontend/i18n";
import type { SettingsPageType } from "@cocalc/util/types/settings";
import {
  getSettingsOverviewSections,
  useSettingsNavigationContext,
} from "./settings-navigation";
import { applyAccountSettingsRoute } from "./settings-routing";
import { getRegisteredSettingsPageDefinition } from "./settings-page-registry";
import {
  renderSettingsPageIcon,
  type SettingsPageDefinition,
} from "./settings-page";

type SettingsOverviewSection = ReturnType<
  typeof getSettingsOverviewSections
>["sections"][number];

export const SETTINGS_OVERVIEW_PAGE = {
  component: SettingsOverview,
  description: defineMessage({
    id: "account.settings.overview.index",
    defaultMessage:
      "Open account settings, preferences, billing, and support pages.",
  }),
  icon: "settings",
  key: "index",
  label: labels.settings,
} satisfies SettingsPageDefinition;

export function SettingsOverview() {
  const intl = useIntl();
  const navigationContext = useSettingsNavigationContext();
  const overview = getSettingsOverviewSections(navigationContext);
  const cardProps = {
    size: "small" as const,
    hoverable: true,
    style: {
      width: IS_MOBILE ? "100%" : 300,
      minWidth: IS_MOBILE ? 0 : 250,
    },
  } as const;
  const flexProps = {
    wrap: true as const,
    gap: IS_MOBILE ? "8px" : "15px",
    style: { marginBottom: IS_MOBILE ? "24px" : "40px" },
  } as const;

  function handleNavigate(page: SettingsPageType) {
    applyAccountSettingsRoute(redux.getActions("account"), { page });
  }

  function renderPageCard(page: SettingsPageType) {
    const definition = getRegisteredSettingsPageDefinition(page);
    if (definition == null) return;
    return (
      <Card key={page} {...cardProps} onClick={() => handleNavigate(page)}>
        <Card.Meta
          avatar={renderSettingsPageIcon(definition.icon, "overview")}
          title={intl.formatMessage(definition.label)}
          description={intl.formatMessage(definition.description)}
        />
      </Card>
    );
  }

  function getSectionDefinition(section: SettingsOverviewSection) {
    if (section.source.type === "group") {
      return {
        icon: section.source.icon,
        label: section.source.label,
      };
    }
    return getRegisteredSettingsPageDefinition(section.source.page);
  }

  function renderOverviewSection(section: SettingsOverviewSection) {
    const definition = getSectionDefinition(section);
    if (definition == null) return;
    return (
      <div key={section.key}>
        <Divider plain>
          {renderSettingsPageIcon(definition.icon, "overview")}{" "}
          {intl.formatMessage(definition.label)}
        </Divider>
        <Flex {...flexProps}>{section.pages.map(renderPageCard)}</Flex>
      </div>
    );
  }

  return (
    <div style={{ padding: IS_MOBILE ? "4px 0 12px 0" : "20px" }}>
      <Flex {...flexProps}>{overview.primaryPages.map(renderPageCard)}</Flex>
      {overview.sections.map(renderOverviewSection)}
    </div>
  );
}
