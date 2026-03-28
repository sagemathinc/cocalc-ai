/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { redux } from "@cocalc/frontend/app-framework";
import type {
  NavigatePath,
  PreferencesSubTabKey,
  PreferencesSubTabType,
  SettingsPageType,
} from "@cocalc/util/types/settings";
import {
  VALID_PREFERENCES_SUB_TYPES,
  VALID_SETTINGS_PAGES,
} from "@cocalc/util/types/settings";

export type AccountSettingsTab = Exclude<SettingsPageType, "index" | "profile">;

export type AccountSettingsRoute =
  | { kind: "index" }
  | { kind: "profile" }
  | {
      kind: "preferences";
      subTab: PreferencesSubTabType;
      subTabKey: PreferencesSubTabKey;
    }
  | { kind: "tab"; page: AccountSettingsTab };

export type SettingsTargetPath =
  | NavigatePath
  | "settings/index"
  | "settings/profile";

type AccountSettingsState = {
  active_page: SettingsPageType | "preferences";
  active_sub_tab?: PreferencesSubTabKey;
};

type AccountSettingsActionsLike = {
  push_state: (url?: string) => void;
  setState: (state: AccountSettingsState) => void;
  set_active_tab: (tab: string) => void;
};

export function createPreferencesSubTabKey(
  subTab: string,
): PreferencesSubTabKey | null {
  if (VALID_PREFERENCES_SUB_TYPES.includes(subTab as PreferencesSubTabType)) {
    return `preferences-${subTab as PreferencesSubTabType}`;
  }
  return null;
}

export function isAccountSettingsTab(
  value: string,
): value is AccountSettingsTab {
  return (
    VALID_SETTINGS_PAGES.includes(value as SettingsPageType) &&
    value !== "index" &&
    value !== "profile"
  );
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
  const [page, subTab] = segments;

  switch (page) {
    case undefined:
    case "":
    case "index":
      return { kind: "index" };
    case "profile":
      return { kind: "profile" };
    case "preferences": {
      const normalizedSubTab = VALID_PREFERENCES_SUB_TYPES.includes(
        subTab as PreferencesSubTabType,
      )
        ? (subTab as PreferencesSubTabType)
        : "appearance";
      return {
        kind: "preferences",
        subTab: normalizedSubTab,
        subTabKey: createPreferencesSubTabKey(normalizedSubTab)!,
      };
    }
    default:
      if (isAccountSettingsTab(page)) {
        return { kind: "tab", page };
      }
      return undefined;
  }
}

export function getAccountSettingsState(
  route: AccountSettingsRoute,
): AccountSettingsState {
  switch (route.kind) {
    case "index":
      return { active_page: "index", active_sub_tab: undefined };
    case "profile":
      return { active_page: "profile", active_sub_tab: undefined };
    case "preferences":
      return {
        active_page: "preferences",
        active_sub_tab: route.subTabKey,
      };
    case "tab":
      return { active_page: route.page, active_sub_tab: undefined };
  }
}

export function getAccountSettingsRouteFromState(
  state: AccountSettingsState,
): AccountSettingsRoute {
  switch (state.active_page) {
    case "index":
      return { kind: "index" };
    case "profile":
      return { kind: "profile" };
    case "preferences": {
      const subTab =
        state.active_sub_tab?.replace(/^preferences-/, "") ?? "appearance";
      const normalizedSubTab = VALID_PREFERENCES_SUB_TYPES.includes(
        subTab as PreferencesSubTabType,
      )
        ? (subTab as PreferencesSubTabType)
        : "appearance";
      return {
        kind: "preferences",
        subTab: normalizedSubTab,
        subTabKey: createPreferencesSubTabKey(normalizedSubTab)!,
      };
    }
    default:
      if (isAccountSettingsTab(state.active_page)) {
        return { kind: "tab", page: state.active_page };
      }
      return { kind: "index" };
  }
}

export function getSettingsTargetPath(
  route: AccountSettingsRoute,
): SettingsTargetPath {
  switch (route.kind) {
    case "index":
      return "settings/index";
    case "profile":
      return "settings/profile";
    case "preferences":
      return `settings/preferences/${route.subTab}`;
    case "tab":
      return `settings/${route.page}`;
  }
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
  if (route.kind === "tab") {
    if (pushHistory) {
      actions.set_active_tab(route.page);
    } else {
      actions.setState(getAccountSettingsState(route));
    }
    return;
  }

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
