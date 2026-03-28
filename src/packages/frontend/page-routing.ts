/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { AuthView } from "@cocalc/frontend/auth/types";
import {
  getAccountSettingsRouteFromState,
  getAccountSettingsState,
  getSettingsTargetPath,
  parseAccountSettingsRoute,
} from "@cocalc/frontend/account/settings-routing";
import { getLegacyCommerceTargetPath } from "@cocalc/util/routing/legacy-commerce";
import type {
  PreferencesSubTabKey,
  SettingsPageType,
} from "@cocalc/util/types/settings";

export type PageTopTab =
  | "account"
  | "auth"
  | "admin"
  | "file-use"
  | "hosts"
  | "notifications"
  | "project"
  | "projects"
  | "ssh";

export type ParsedPageTarget =
  | { page: "projects" }
  | { page: "project"; target: string }
  | {
      page: "account";
      tab: SettingsPageType | "preferences";
      sub_tab?: PreferencesSubTabKey;
    }
  | {
      page: "notifications";
      tab?: "mentions";
    }
  | { page: "file-use" }
  | { page: "admin" }
  | { page: "hosts" }
  | { page: "ssh" }
  | {
      page: "auth";
      view: AuthView;
    };

function parseAuthView(value?: string): AuthView {
  switch (value) {
    case "sign-up":
      return "sign-up";
    case "password-reset":
      return "password-reset";
    case "sign-in":
    default:
      return "sign-in";
  }
}

export function parsePageTarget(target?: string): ParsedPageTarget {
  if (target == undefined) {
    return { page: "account", tab: "index" };
  }
  const normalizedTarget = getLegacyCommerceTargetPath(target) ?? target;
  const segments = normalizedTarget.split("/");
  switch (segments[0]) {
    case "projects":
      if (segments.length < 2 || (segments.length == 2 && segments[1] == "")) {
        return { page: "projects" };
      }
      return { page: "project", target: segments.slice(1).join("/") };
    case "settings": {
      const route = parseAccountSettingsRoute(segments.slice(1)) ?? {
        kind: "index",
      };
      const state = getAccountSettingsState(route);
      return {
        page: "account",
        tab: state.active_page,
        sub_tab: state.active_sub_tab,
      };
    }
    case "notifications":
      return { page: "notifications" };
    case "file-use":
      return { page: "file-use" };
    case "admin":
      return { page: "admin" };
    case "hosts":
      return { page: "hosts" };
    case "ssh":
      return { page: "ssh" };
    case "auth":
      return { page: "auth", view: parseAuthView(segments[1]) };
    default:
      return { page: "account", tab: "index" };
  }
}

export function getPageTopTab(parsed: ParsedPageTarget): PageTopTab {
  switch (parsed.page) {
    case "project":
      return "project";
    case "account":
      return "account";
    default:
      return parsed.page;
  }
}

export function getInitialAccountPageState(parsed: ParsedPageTarget):
  | {
      active_page: SettingsPageType | "preferences";
      active_sub_tab?: PreferencesSubTabKey;
    }
  | undefined {
  if (parsed.page !== "account") {
    return undefined;
  }
  return {
    active_page: parsed.tab,
    active_sub_tab: parsed.sub_tab,
  };
}

export function getPageTargetPath(parsed: ParsedPageTarget): string {
  switch (parsed.page) {
    case "projects":
      return "projects";
    case "project":
      return `projects/${parsed.target}`;
    case "account":
      return getSettingsTargetPath(
        getAccountSettingsRouteFromState({
          active_page: parsed.tab,
          active_sub_tab: parsed.sub_tab,
        }),
      );
    case "notifications":
      return "notifications";
    case "file-use":
      return "file-use";
    case "admin":
      return "admin";
    case "hosts":
      return "hosts";
    case "ssh":
      return "ssh";
    case "auth":
      return `auth/${parsed.view}`;
  }
}

export function getPageUrlPath(parsed: ParsedPageTarget): string {
  return `/${getPageTargetPath(parsed)}`;
}
