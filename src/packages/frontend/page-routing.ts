/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { is_valid_uuid_string } from "@cocalc/util/misc";
import {
  isMyPersonalUrlOwner,
  myProjectAlias,
  myProjectForAlias,
  personalUrlOwner,
} from "./app/personal-url-identity";
import type { AuthView } from "@cocalc/frontend/auth/types";
import {
  SEARCH_SCOPES,
  searchPath,
  type SearchScope,
} from "@cocalc/frontend/search/search-store";
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
  | "people"
  | "project"
  | "projects"
  | "share"
  | "ssh";

export type ParsedPageTarget =
  | { page: "projects" }
  | {
      page: "agents";
      agent_id?: string;
      library?: boolean;
      // The Agents page (all your agents and shared ones).
      overview?: boolean;
      artifact_project_id?: string;
      artifact_entry_id?: string;
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
  // route: "conversations/<project_id>/<conversation_id>" or
  // "collaborators/<account_id>"
  | { page: "people"; route?: string }
  // A personal URL: "u/<owner>/<kind>/<alias>", resolved on load.
  | { page: "u"; path: string }
  // Search results: "search/<scope>/<query>", over the scope's page.
  | { page: "search"; scope: SearchScope; query: string }
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
    case "all-agents":
      return { page: "agents", overview: true };
    case "artifacts":
      return {
        page: "agents",
        library: true,
        // Keep malformed suffixes intact for the Library's not-found UI.
        // In particular, never truncate extra segments to a valid entry.
        artifact_project_id:
          cleanTarget === "artifacts/" ? undefined : segments[1],
        artifact_entry_id:
          segments.length > 2 ? segments.slice(2).join("/") : undefined,
      };
    case "agents":
      return {
        page: "agents",
        agent_id: segments.slice(1).filter(Boolean).join("/") || undefined,
      };
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
    case "people":
      return {
        page: "people",
        route: segments.slice(1).filter(Boolean).join("/") || undefined,
      };
    case "search": {
      const scope = SEARCH_SCOPES.includes(segments[1] as SearchScope)
        ? (segments[1] as SearchScope)
        : "agents";
      // The query may contain (decoded) slashes.
      let query = segments.slice(2).join("/");
      try {
        query = decodeURIComponent(query);
      } catch {
        // already decoded
      }
      return { page: "search", scope, query };
    }
    case "u": {
      // My own named agents and artifacts open directly; anyone else's
      // personal URL is resolved by the hub.
      const [, owner, kind, ...rest] = segments.filter(Boolean);
      const alias = rest.join("/");
      if (kind === "projects") {
        // /u/<owner>/projects/<alias>/<path in project>. A trailing slash
        // (a folder) matters, so use the unfiltered segments.
        const project_id =
          owner && rest[0] && isMyPersonalUrlOwner(owner)
            ? myProjectForAlias(rest[0])
            : undefined;
        if (project_id)
          return {
            page: "project",
            target: [project_id, ...segments.slice(4)].join("/"),
          };
        return { page: "u", path: cleanTarget.replace(/^\/+/, "") };
      }
      if (owner && alias && isMyPersonalUrlOwner(owner)) {
        if (kind === "agents")
          return { page: "agents", agent_id: decodeURIComponent(alias) };
        if (kind === "artifacts")
          return {
            page: "agents",
            library: true,
            artifact_project_id: decodeURIComponent(alias),
          };
      }
      return { page: "u", path: segments.filter(Boolean).join("/") };
    }
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
    case "u":
      // Shown while the personal URL resolves.
      return "people";
    case "search":
      return parsed.scope === "projects" || parsed.scope === "people"
        ? parsed.scope
        : "agents";
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
      if (parsed.overview) return "all-agents";
      if (parsed.library) {
        if (parsed.artifact_project_id == null) return "artifacts";
        // A named artifact (personal alias, not a project id) is mine:
        // its address says whose name it is.
        if (
          parsed.artifact_entry_id == null &&
          !is_valid_uuid_string(parsed.artifact_project_id) &&
          personalUrlOwner()
        )
          return `u/${encodeURIComponent(personalUrlOwner()!)}/artifacts/${encodeURIComponent(parsed.artifact_project_id)}`;
        const suffix =
          parsed.artifact_entry_id == null
            ? [parsed.artifact_project_id]
            : [
                parsed.artifact_project_id,
                ...parsed.artifact_entry_id.split("/"),
              ];
        return `artifacts/${suffix.map(encodeURIComponent).join("/")}`;
      }
      // A named agent (not an id) is mine: its address says whose name it is.
      if (
        parsed.agent_id &&
        parsed.agent_id !== "new" &&
        !is_valid_uuid_string(parsed.agent_id) &&
        personalUrlOwner()
      )
        return `u/${encodeURIComponent(personalUrlOwner()!)}/agents/${encodeURIComponent(parsed.agent_id)}`;
      return parsed.agent_id
        ? `agents/${encodeURIComponent(parsed.agent_id)}`
        : "agents";
    case "projects":
      return "projects";
    case "project":
      return personalProjectPath(`projects/${parsed.target}`);
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
    case "people":
      return parsed.route ? `people/${parsed.route}` : "people";
    case "u":
      return parsed.path;
    case "search":
      return searchPath(parsed.scope, parsed.query);
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

// projects/<id>/<rest> as /u/<me>/projects/<alias>/<rest> when I gave that
// project an alias; otherwise unchanged. Accepts and keeps a leading slash.
export function personalProjectPath(path: string): string {
  const match = /^(\/?)projects\/([0-9a-f-]{36})(\/.*)?$/i.exec(path);
  if (!match) return path;
  const owner = personalUrlOwner();
  const alias = myProjectAlias(match[2].toLowerCase());
  if (!owner || !alias) return path;
  return `${match[1]}u/${encodeURIComponent(owner)}/projects/${encodeURIComponent(alias)}${match[3] ?? ""}`;
}
