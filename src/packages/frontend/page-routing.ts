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
import {
  getAdminTargetPath,
  parseAdminRoute,
  type AdminRoute,
} from "@cocalc/frontend/admin/routing";
import { getLegacyCommerceTargetPath } from "@cocalc/util/routing/legacy-commerce";
import type { SettingsPageType } from "@cocalc/util/types/settings";
import { personalUrlPath } from "@cocalc/util/personal-urls";
import { is_valid_uuid_string } from "@cocalc/util/misc";
import {
  collaboratorsTargetPath,
  parseCollaboratorsRoute,
  parsePrivateAliasRoute,
  type ParsedCollaboratorsRoute,
} from "@cocalc/frontend/collaborators/routing";

export type PageTopTab =
  | "account"
  | "agents"
  | "auth"
  | "claim"
  | "admin"
  | "docs"
  | "file-use"
  | "hosts"
  | "notifications"
  | "project"
  | "projects"
  | "share"
  | "ssh";

export type ParsedPageTarget =
  | { page: "projects" }
  | {
      page: "agents";
      /** Owner-qualified route, never a viewer-local agent/artifact name. */
      personal_url?: string;
      owner?: string;
      agent_id?: string;
      library?: boolean;
      artifact_project_id?: string;
      artifact_entry_id?: string;
      collaborators?: ParsedCollaboratorsRoute;
    }
  | { page: "project"; target: string }
  | {
      page: "account";
      tab: SettingsPageType;
    }
  | {
      page: "notifications";
      tab?: "mentions";
    }
  | { page: "docs"; print?: boolean; slug?: string }
  | { page: "file-use" }
  | { page: "admin"; route: AdminRoute }
  | { page: "hosts" }
  | { page: "share"; slug: string }
  | { page: "ssh" }
  | {
      page: "auth";
      view: AuthView;
    }
  | {
      page: "claim";
      kind: "site-license";
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
  const cleanTarget = normalizedTarget.split(/[?#]/)[0];
  const segments = cleanTarget.split("/");
  switch (segments[0]) {
    case "u":
      // Keep even malformed qualified addresses separate from local aliases.
      return { page: "agents", personal_url: cleanTarget };
    case "chats":
    case "people":
      return {
        page: "agents",
        collaborators: parsePrivateAliasRoute(segments[0], segments.slice(1)),
      };
    case "collaborators":
      return {
        page: "agents",
        collaborators: parseCollaboratorsRoute(segments.slice(1)),
      };
    case "artifacts":
      return {
        page: "agents",
        library: true,
        // Keep malformed suffixes intact for the artifact not-found UI.
        // In particular, never truncate extra segments to a valid entry.
        artifact_project_id:
          cleanTarget === "artifacts/" ? undefined : segments[1],
        artifact_entry_id:
          segments.length > 2 ? segments.slice(2).join("/") : undefined,
      };
    case "home":
    case "agents": {
      const agentId = segments.slice(1).join("/") || undefined;
      if (agentId && agentId !== "new" && !is_valid_uuid_string(agentId))
        return { page: "agents", personal_url: cleanTarget };
      return {
        page: "agents",
        agent_id: agentId,
      };
    }
    case "projects":
      if (segments.length < 2 || (segments.length == 2 && segments[1] == "")) {
        return { page: "projects" };
      }
      return { page: "project", target: segments.slice(1).join("/") };
    case "settings": {
      const route = parseAccountSettingsRoute(segments.slice(1)) ?? {
        page: "index",
      };
      const state = getAccountSettingsState(route);
      return {
        page: "account",
        tab: state.active_page,
      };
    }
    case "notifications":
      return { page: "notifications" };
    case "app-docs":
      if (segments[1] === "print") {
        return {
          page: "docs",
          print: true,
        };
      }
      return {
        page: "docs",
        slug: segments.slice(1).filter(Boolean).join("/") || undefined,
      };
    case "file-use":
      return { page: "file-use" };
    case "admin":
      return {
        page: "admin",
        route: parseAdminRoute(segments) ?? { kind: "index" },
      };
    case "hosts":
      return { page: "hosts" };
    case "share":
      return {
        page: "share",
        slug: segments.slice(1).filter(Boolean).join("/"),
      };
    case "ssh":
      return { page: "ssh" };
    case "auth":
      return { page: "auth", view: parseAuthView(segments[1]) };
    case "claim":
      if (segments[1] === "site-license") {
        return { page: "claim", kind: "site-license" };
      }
      return { page: "account", tab: "index" };
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
      active_page: SettingsPageType;
    }
  | undefined {
  if (parsed.page !== "account") {
    return undefined;
  }
  return {
    active_page: parsed.tab,
  };
}

export function getPageTargetPath(parsed: ParsedPageTarget): string {
  switch (parsed.page) {
    case "agents":
      if (parsed.personal_url) return parsed.personal_url.replace(/^\//, "");
      if (parsed.collaborators)
        return collaboratorsTargetPath(parsed.collaborators);
      if (parsed.library) {
        if (parsed.artifact_project_id == null) return "artifacts";
        if (parsed.owner && parsed.artifact_entry_id == null)
          return personalUrlPath(
            parsed.owner,
            "artifacts",
            parsed.artifact_project_id,
          ).slice(1);
        const suffix =
          parsed.artifact_entry_id == null
            ? [parsed.artifact_project_id]
            : [
                parsed.artifact_project_id,
                ...parsed.artifact_entry_id.split("/"),
              ];
        return `artifacts/${suffix.map(encodeURIComponent).join("/")}`;
      }
      if (!parsed.agent_id) return "agents";
      if (
        parsed.owner &&
        parsed.agent_id !== "new" &&
        !is_valid_uuid_string(parsed.agent_id)
      )
        return personalUrlPath(parsed.owner, "agents", parsed.agent_id).slice(
          1,
        );
      return `agents/${encodeURIComponent(parsed.agent_id)}`;
    case "projects":
      return "projects";
    case "project":
      return `projects/${parsed.target}`;
    case "account":
      return getSettingsTargetPath(
        getAccountSettingsRouteFromState({
          active_page: parsed.tab,
        }),
      );
    case "notifications":
      return "notifications";
    case "docs":
      if (parsed.print) {
        return "app-docs/print";
      }
      return parsed.slug ? `app-docs/${parsed.slug}` : "app-docs";
    case "file-use":
      return "file-use";
    case "admin":
      return getAdminTargetPath(parsed.route);
    case "hosts":
      return "hosts";
    case "share":
      return `share/${parsed.slug}`;
    case "ssh":
      return "ssh";
    case "auth":
      return `auth/${parsed.view}`;
    case "claim":
      return "claim/site-license";
  }
}

export function getPageUrlPath(parsed: ParsedPageTarget): string {
  return `/${getPageTargetPath(parsed)}`;
}
