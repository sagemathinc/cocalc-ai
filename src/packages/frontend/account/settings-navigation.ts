/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { MessageDescriptor } from "react-intl";

import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { labels } from "@cocalc/frontend/i18n";
import { lite } from "@cocalc/frontend/lite";
import type { SettingsPageType } from "@cocalc/util/types/settings";
import type { SettingsPageIcon } from "./settings-page";

export type SettingsNavigationContext = {
  isAdmin: boolean;
  isCommercial: boolean;
  isLite: boolean;
  zendesk: boolean;
};

export function useSettingsNavigationContext(): SettingsNavigationContext {
  return {
    isAdmin: !!useTypedRedux("account", "is_admin"),
    isCommercial: !!useTypedRedux("customize", "is_commercial"),
    isLite: lite,
    zendesk: !!useTypedRedux("customize", "zendesk"),
  };
}

type Visibility = (context: SettingsNavigationContext) => boolean;
type OverviewPlacement = "hidden" | "primary" | "section";
type GroupKey = "preferences" | "licenses" | "billing";

type PageNode = {
  overview?: OverviewPlacement;
  page: SettingsPageType;
  type: "page";
  visible?: Visibility;
};

type GroupNode = {
  icon: SettingsPageIcon;
  key: GroupKey;
  label: MessageDescriptor;
  overview?: OverviewPlacement;
  pages: PageNode[];
  type: "group";
  visible?: Visibility;
};

type NavigationNode = GroupNode | PageNode;
type VisibleNavigationNode = PageNode | (GroupNode & { pages: PageNode[] });

type OverviewSection = {
  key: string;
  pages: SettingsPageType[];
  source: VisibleNavigationNode;
};

export const ACCOUNT_SETTINGS_NAVIGATION: NavigationNode[] = [
  { type: "page", page: "index", overview: "hidden" },
  { type: "page", page: "profile", overview: "primary" },
  {
    type: "page",
    page: "membership",
    overview: "primary",
    visible: ({ isLite }) => !isLite,
  },
  {
    type: "page",
    page: "usage-limits",
    overview: "primary",
    visible: ({ isLite }) => !isLite,
  },
  {
    type: "group",
    key: "licenses",
    icon: "key",
    label: labels.licenses,
    overview: "section",
    visible: ({ isLite }) => !isLite,
    pages: [
      {
        type: "page",
        page: "team-licenses",
        visible: ({ isAdmin, isCommercial }) => isCommercial || isAdmin,
      },
      { type: "page", page: "site-licenses" },
      { type: "page", page: "software-licenses" },
    ],
  },
  {
    type: "group",
    key: "preferences",
    icon: "cogs",
    label: labels.preferences,
    overview: "primary",
    pages: [
      { type: "page", page: "appearance" },
      { type: "page", page: "editor" },
      { type: "page", page: "keyboard" },
      { type: "page", page: "ai" },
      {
        type: "page",
        page: "communication",
        visible: ({ isLite }) => !isLite,
      },
      { type: "page", page: "keys", visible: ({ isLite }) => !isLite },
      { type: "page", page: "other" },
    ],
  },
  {
    type: "group",
    key: "billing",
    visible: ({ isAdmin, isCommercial }) => isCommercial || isAdmin,
    icon: "money-check",
    label: labels.billing,
    overview: "section",
    pages: [
      { type: "page", page: "vouchers" },
      {
        type: "page",
        page: "purchases",
        visible: ({ isCommercial }) => isCommercial,
      },
      {
        type: "page",
        page: "payments",
        visible: ({ isCommercial }) => isCommercial,
      },
      {
        type: "page",
        page: "payment-methods",
        overview: "hidden",
        visible: ({ isCommercial }) => isCommercial,
      },
      {
        type: "page",
        page: "statements",
        visible: ({ isCommercial }) => isCommercial,
      },
    ],
  },
  {
    type: "page",
    page: "support",
    overview: "section",
    visible: ({ zendesk }) => zendesk,
  },
];

function isVisible(
  item: { visible?: Visibility },
  context: SettingsNavigationContext,
): boolean {
  return item.visible == null || item.visible(context);
}

export function getVisibleSettingsNavigation(
  context: SettingsNavigationContext,
): VisibleNavigationNode[] {
  const visibleNodes: VisibleNavigationNode[] = [];
  for (const node of ACCOUNT_SETTINGS_NAVIGATION) {
    if (!isVisible(node, context)) continue;
    if (node.type === "page") {
      visibleNodes.push(node);
      continue;
    }
    const pages = node.pages.filter((page) => isVisible(page, context));
    if (pages.length > 0) {
      visibleNodes.push({ ...node, pages });
    }
  }
  return visibleNodes;
}

export function getSettingsNavigationGroupKey(
  page: SettingsPageType,
): GroupKey | undefined {
  for (const node of ACCOUNT_SETTINGS_NAVIGATION) {
    if (
      node.type === "group" &&
      node.pages.some((item) => item.page === page)
    ) {
      return node.key;
    }
  }
}

export function getSettingsOverviewSections(
  context: SettingsNavigationContext,
): {
  primaryPages: SettingsPageType[];
  sections: OverviewSection[];
} {
  const primaryPages: SettingsPageType[] = [];
  const sections: OverviewSection[] = [];

  for (const node of getVisibleSettingsNavigation(context)) {
    if (node.overview === "hidden") continue;

    if (node.type === "page") {
      if (node.overview === "primary") {
        primaryPages.push(node.page);
      } else {
        sections.push({ key: node.page, pages: [node.page], source: node });
      }
      continue;
    }

    const pages = node.pages
      .filter(({ overview }) => overview !== "hidden")
      .map(({ page }) => page);
    if (pages.length === 0) continue;

    if (node.overview === "primary") {
      primaryPages.push(...pages);
    } else {
      sections.push({ key: node.key, pages, source: node });
    }
  }

  return { primaryPages, sections };
}
