/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { redux } from "@cocalc/frontend/app-framework";
import type {
  BillingSubTabType,
  NavigatePath,
  PreferencesSubTabKey,
  PreferencesSubTabType,
  SettingsPageType,
} from "@cocalc/util/types/settings";
import {
  VALID_BILLING_SUB_TYPES,
  VALID_PREFERENCES_SUB_TYPES,
  VALID_SETTINGS_PAGES,
} from "@cocalc/util/types/settings";

export type AccountSettingsGroupKey = "preferences" | "billing";

type AccountSettingsPagePath =
  | "settings"
  | "settings/index"
  | `settings/${Exclude<SettingsPageType, "index">}`;

type AccountSettingsRouteDefinition = {
  group?: AccountSettingsGroupKey;
  page: SettingsPageType;
  path: AccountSettingsPagePath;
};

type AccountSettingsGroupDefinition = {
  defaultPage: SettingsPageType;
  key: AccountSettingsGroupKey;
};

export type AccountSettingsRoute = { page: SettingsPageType };

export type SettingsTargetPath = AccountSettingsPagePath | NavigatePath;

type AccountSettingsState = {
  active_page: SettingsPageType;
};

type AccountSettingsLegacyState = {
  active_page: string;
  active_sub_tab?: PreferencesSubTabKey;
};

type AccountSettingsActionsLike = {
  push_state: (url?: string) => void;
  setState: (state: AccountSettingsState) => void;
};

export const ACCOUNT_SETTINGS_GROUP_DEFINITIONS: readonly AccountSettingsGroupDefinition[] =
  [
    { key: "preferences", defaultPage: "appearance" },
    { key: "billing", defaultPage: "subscriptions" },
  ] as const;

export const ACCOUNT_SETTINGS_ROUTE_DEFINITIONS: readonly AccountSettingsRouteDefinition[] =
  [
    { page: "index", path: "settings" },
    { page: "profile", path: "settings/profile" },
    {
      group: "preferences",
      page: "appearance",
      path: "settings/appearance",
    },
    {
      group: "preferences",
      page: "editor",
      path: "settings/editor",
    },
    {
      group: "preferences",
      page: "keyboard",
      path: "settings/keyboard",
    },
    { group: "preferences", page: "ai", path: "settings/ai" },
    {
      group: "preferences",
      page: "communication",
      path: "settings/communication",
    },
    { group: "preferences", page: "keys", path: "settings/keys" },
    { group: "preferences", page: "other", path: "settings/other" },
    {
      group: "billing",
      page: "subscriptions",
      path: "settings/subscriptions",
    },
    { group: "billing", page: "licenses", path: "settings/licenses" },
    { group: "billing", page: "store", path: "settings/store" },
    { group: "billing", page: "vouchers", path: "settings/vouchers" },
    { group: "billing", page: "purchases", path: "settings/purchases" },
    { group: "billing", page: "payments", path: "settings/payments" },
    {
      group: "billing",
      page: "payment-methods",
      path: "settings/payment-methods",
    },
    {
      group: "billing",
      page: "statements",
      path: "settings/statements",
    },
    { page: "support", path: "settings/support" },
  ] as const;

const DEFAULT_GROUP_PAGES: Record<string, SettingsPageType> =
  Object.fromEntries(
    ACCOUNT_SETTINGS_GROUP_DEFINITIONS.map(({ key, defaultPage }) => [
      key,
      defaultPage,
    ]),
  );

const GROUPS_BY_PAGE = new Map<SettingsPageType, AccountSettingsGroupKey>(
  ACCOUNT_SETTINGS_ROUTE_DEFINITIONS.flatMap(({ group, page }) =>
    group == null ? [] : [[page, group]],
  ),
);

const PAGES_BY_GROUP = new Map<AccountSettingsGroupKey, SettingsPageType[]>(
  ACCOUNT_SETTINGS_GROUP_DEFINITIONS.map(({ key }) => [
    key,
    ACCOUNT_SETTINGS_ROUTE_DEFINITIONS.filter(({ group }) => group === key).map(
      ({ page }) => page,
    ),
  ]),
);

const ROUTES_BY_PAGE = new Map<SettingsPageType, AccountSettingsPagePath>(
  ACCOUNT_SETTINGS_ROUTE_DEFINITIONS.map(({ page, path }) => [page, path]),
);

const PAGES_BY_PATH = new Map<string, SettingsPageType>(
  ACCOUNT_SETTINGS_ROUTE_DEFINITIONS.map(({ page, path }) => [
    path.replace(/^settings\/?/, ""),
    page,
  ]),
);

export function isAccountSettingsPageKey(
  value: string,
): value is SettingsPageType {
  return VALID_SETTINGS_PAGES.includes(value as SettingsPageType);
}

export function getAccountSettingsGroupKey(
  page: SettingsPageType,
): AccountSettingsGroupKey | undefined {
  return GROUPS_BY_PAGE.get(page);
}

export function getAccountSettingsGroupPages(
  group: AccountSettingsGroupKey,
): SettingsPageType[] {
  return PAGES_BY_GROUP.get(group) ?? [];
}

function normalizeLegacyPreferencesPage(
  subTab?: PreferencesSubTabKey,
): SettingsPageType {
  const subTabType = subTab?.replace(/^preferences-/, "");
  if (
    VALID_PREFERENCES_SUB_TYPES.includes(subTabType as PreferencesSubTabType)
  ) {
    return subTabType as PreferencesSubTabType;
  }
  return DEFAULT_GROUP_PAGES.preferences;
}

function normalizeLegacyGroupedPage(
  page: string,
): SettingsPageType | undefined {
  const preferencesPage = page.replace(/^preferences-/, "");
  if (
    preferencesPage !== page &&
    VALID_PREFERENCES_SUB_TYPES.includes(
      preferencesPage as PreferencesSubTabType,
    )
  ) {
    return preferencesPage as PreferencesSubTabType;
  }
  const billingPage = page.replace(/^billing-/, "");
  if (
    billingPage !== page &&
    VALID_BILLING_SUB_TYPES.includes(billingPage as BillingSubTabType)
  ) {
    return billingPage as BillingSubTabType;
  }
  return undefined;
}

export function parseAccountSettingsRoute(
  input: string | readonly string[],
): AccountSettingsRoute | undefined {
  const rawSegments =
    typeof input === "string" ? input.split("/") : Array.from(input);
  const segments = rawSegments.filter(Boolean);
  if (segments[0] === "settings") {
    segments.shift();
  }
  if (segments.length === 0 || segments[0] === "index") {
    return { page: "index" };
  }

  const groupDefault = DEFAULT_GROUP_PAGES[segments[0]];
  if (segments.length === 1 && groupDefault != null) {
    return { page: groupDefault };
  }

  const path = segments.join("/");
  const page = PAGES_BY_PATH.get(path);
  if (page != null) {
    return { page };
  }
  return undefined;
}

export function getAccountSettingsState(
  route: AccountSettingsRoute,
): AccountSettingsState {
  return { active_page: route.page };
}

export function getAccountSettingsRouteFromState(
  state: AccountSettingsLegacyState,
): AccountSettingsRoute {
  if (state.active_page === "preferences") {
    return { page: normalizeLegacyPreferencesPage(state.active_sub_tab) };
  }
  if (isAccountSettingsPageKey(state.active_page)) {
    return { page: state.active_page };
  }
  return { page: normalizeLegacyGroupedPage(state.active_page) ?? "index" };
}

export function getSettingsTargetPath(
  route: AccountSettingsRoute,
): SettingsTargetPath {
  return ROUTES_BY_PAGE.get(route.page) ?? "settings";
}

export function getSettingsUrlPath(route: AccountSettingsRoute): string {
  return `/${getSettingsTargetPath(route)}`;
}

export function getSettingsPushStatePath(route: AccountSettingsRoute): string {
  return `/${getSettingsTargetPath(route).replace(/^settings\/?/, "")}`;
}

export function applyAccountSettingsRoute(
  actions: AccountSettingsActionsLike,
  route: AccountSettingsRoute,
  opts?: { pushHistory?: boolean },
): void {
  const pushHistory = opts?.pushHistory ?? true;
  actions.setState(getAccountSettingsState(route));
  if (pushHistory) {
    actions.push_state(getSettingsPushStatePath(route));
  }
}

export function openAccountSettings(
  route: AccountSettingsRoute,
  opts?: { changeHistory?: boolean },
): void {
  const changeHistory = opts?.changeHistory ?? true;
  redux.getActions("page").set_active_tab("account", changeHistory);
  applyAccountSettingsRoute(redux.getActions("account"), route, {
    pushHistory: changeHistory,
  });
}
