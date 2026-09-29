/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/* Code related to the history and URL in the browser bar.
See also src/packages/util/routing/app.ts
and src/packages/hub/servers/app/app-redirect.ts

The URI schema handled by the single page app is as follows:
     Overall settings:
        https://cocalc.ai/settings
     Admin only page:
        https://cocalc.ai/admin
     Account profile:
        https://cocalc.ai/settings/profile
     Preferences:
        https://cocalc.ai/settings/appearance
        https://cocalc.ai/settings/ai
        https://cocalc.ai/settings/keys
        etc.
     Billing:
        https://cocalc.ai/settings/membership
        https://cocalc.ai/settings/payment-methods
        https://cocalc.ai/settings/statements
     Support:
        https://cocalc.ai/settings/support
     Projects page:
        https://cocalc.ai/projects/
     Specific project:
        https://cocalc.ai/projects/project-id/
     Create new file page (in given directory):
        https://cocalc.ai/projects/project-id/new/path/to/dir
     Search (in given directory):
        https://cocalc.ai/projects/project-id/search/path/to/dir
     Settings:
        https://cocalc.ai/projects/project-id/settings
     Log:
        https://cocalc.ai/projects/project-id/log
     Folder listing (must have slash at end):
       https://cocalc.ai/projects/project-id/files/path/to/dir/
     Open file:
       https://cocalc.ai/projects/project-id/files/path/to/file
     (From before) raw http:
       https://cocalc.ai/projects/project-id/raw/path/...
     (From before) proxy server (supports websockets and ssl) to a given port.
       https://cocalc.ai/projects/project-id/port/<number>/.
*/

import { join } from "path";
import { cancelAliasNavigation } from "./collaborators/navigation";
import { resolvePersonalUrl } from "./personal-url-navigation";
import {
  cancelPersonalUrlNavigation,
  closedPersonalUrlState,
} from "./personal-url-state";

import { redux } from "@cocalc/frontend/app-framework";
import { alert_message } from "@cocalc/frontend/alerts";
import {
  applyAccountSettingsRoute,
  getAccountSettingsRouteFromState,
} from "@cocalc/frontend/account/settings-routing";
import { IS_EMBEDDED } from "@cocalc/frontend/client/handle-target";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  getPageUrlPath,
  parsePageTarget,
  type ParsedPageTarget,
} from "@cocalc/frontend/page-routing";
import Fragment from "@cocalc/frontend/misc/fragment-id";
import { handoffToPrivateProjectApp } from "@cocalc/frontend/project/private-app-handoff";
import { parsePrivateProjectAppHandoffTarget } from "@cocalc/frontend/project-routing";
import { is_valid_uuid_string } from "@cocalc/util/misc";
import { getNotificationFilterFromFragment } from "./notifications/fragment";
import {
  APP_NAVIGATION_EVENT,
  createGitReviewNavigationSearch,
  consumeGitReviewOnlyNavigation,
} from "./git/review-route";

const reviewSearchForNavigation = createGitReviewNavigationSearch(
  new URL(location.href),
);

// Determine query params part of URL based on state of the project store.
// This also leaves unchanged any *other* params already there (i.e., not
// the "managed" params that are explicitly listed in the code below).
function params(): string {
  const page = redux.getStore("page");
  const u = new URL(location.href);
  if (page != null) {
    // `network` was briefly used by the Agents page and must not survive
    // navigation now that its filter is localStorage-only.
    for (const param of ["get_api_key", "test", "network"]) {
      const val = page.get(param);
      if (val) {
        u.searchParams.set(param, val);
      } else {
        u.searchParams.delete(param);
      }
    }
  }
  return u.search;
}

// The last explicitly set url.
let last_url: string | undefined = undefined;

function isPublicApp(): boolean {
  return Boolean((globalThis as any).__cocalc_public_app);
}

// Update what params are set to in the URL based on state of project store,
// leaving the rest of the URL the same.
export function update_params() {
  if (last_url != null) {
    set_url(last_url);
  }
}

// the url must already be URI encoded, e.g., "a/b ? c.md" should be encoded as 'a/b%20?%20c.md'
export function set_url(url: string, hash?: string) {
  set_url_with_search(url, undefined, hash);
}

/** Metadata-only URL canonicalization; preserve Back/Forward history. */
export function replace_url(url: string, hash?: string) {
  set_url_with_search(url, undefined, hash, true);
}

export function set_url_with_search(
  url: string,
  search?: string,
  hash?: string,
  replace = false,
) {
  if (IS_EMBEDDED) {
    // no need to mess with url in embedded mode.
    return;
  }
  const personalUrl = redux.getStore("page")?.get?.("personal_url");
  if (personalUrl && url.replace(/^\//, "").split(/[?#]/)[0] !== personalUrl) {
    cancelPersonalUrlNavigation();
    redux.getActions("page").setState(closedPersonalUrlState);
  }
  last_url = url;
  const queryIndex = url.indexOf("?");
  const path = queryIndex === -1 ? url : url.slice(0, queryIndex);
  const routeSearch = queryIndex === -1 ? "" : url.slice(queryIndex + 1);
  const current = new URL(location.href);
  current.search = params();
  const queryParams = new URLSearchParams(
    search ?? reviewSearchForNavigation(current, join(appBasePath, path)),
  );
  // Invitation selection belongs to the destination, not the previous URL.
  if (search == null) queryParams.delete("invitation_id");
  new URLSearchParams(routeSearch).forEach((value, key) =>
    queryParams.set(key, value),
  );
  const destination = parsePageTarget(path.replace(/^\//, ""));
  if (
    destination.page !== "agents" ||
    destination.collaborators?.view !== "invites"
  ) {
    queryParams.delete("invitation_id");
  }
  const query_params = queryParams.size ? `?${queryParams}` : "";
  // Empty artifact segments are invalid selections, not redundant separators.
  // path.join would turn /artifacts//project/entry into a different, valid route.
  const full_url =
    /^\/?(?:u|artifacts|collaborators|chats|people)(?:\/|$)/.test(path)
      ? `${join(appBasePath, "/")}${path.replace(/^\//, "")}${query_params}${hash ?? location.hash}`
      : join(appBasePath, path + query_params + (hash ?? location.hash));
  if (full_url === location.pathname + location.search + location.hash) {
    // Back/Forward can change the current URL without going through set_url.
    // Rewriting that URL would push a duplicate and discard Forward history.
    return;
  }
  if (replace) history.replaceState({}, "", full_url);
  else history.pushState({}, "", full_url);
  consumeGitReviewOnlyNavigation(new URL(location.href));
  window.dispatchEvent(new Event(APP_NAVIGATION_EVENT));
}

// Now load any specific page/project/previous state
export function load_target(
  target: string,
  ignore_kiosk: boolean = false,
  change_history: boolean = true,
) {
  cancelAliasNavigation();
  if (target?.[0] == "/") {
    target = target.slice(1);
  }
  let hash;
  const i = target.lastIndexOf("#");
  if (i != -1) {
    hash = target.slice(i + 1);
    target = target.slice(0, i);
  } else {
    hash = "";
  }
  if (!target) {
    return;
  }
  if (target === "help" || target.startsWith("help/")) {
    redux.getActions("page").set_active_tab("about", change_history);
    return;
  }
  const parsed = parsePageTarget(target);
  if (parsed.page === "agents" && parsed.personal_url) {
    // Start watching before login/account hydration. The namespace owner stays
    // in the URL; no viewer-local alias resolver ever sees this route.
    void resolvePersonalUrl(parsed.personal_url);
    if (
      !redux.getStore("account").get("is_logged_in") &&
      !webapp_client.is_signed_in()
    ) {
      redux.getActions("page").set_active_tab("account", false);
    } else {
      redux.getActions("page").set_active_tab("agents", false);
      if (change_history) set_url(getPageUrlPath(parsed));
    }
    return;
  }
  if (
    !redux.getStore("account").get("is_logged_in") &&
    !webapp_client.is_signed_in() &&
    parsed.page !== "auth" &&
    parsed.page !== "claim" &&
    parsed.page !== "share"
  ) {
    // this will redirect to the sign in page after a brief pause
    redux.getActions("page").set_active_tab("account", false);
    return;
  }
  switch (parsed.page) {
    case "agents":
      redux.getActions("page").setState({
        ...closedPersonalUrlState,
        library_open: parsed.library === true,
        library_project_id: parsed.artifact_project_id,
        library_entry_id: parsed.artifact_entry_id,
        collaborators_open: parsed.collaborators != null,
        collaborators_view: parsed.collaborators?.view,
        collaborators_project_id: parsed.collaborators?.projectId,
        collaborators_project_ids: parsed.collaborators?.projectIds,
        collaborators_person_id: parsed.collaborators?.personId,
        collaborators_contact_id: parsed.collaborators?.contactId,
        collaborators_invitation_id: parsed.collaborators?.invitationId,
        collaborators_resource_kind: parsed.collaborators?.resourceKind,
        collaborators_resource_id: parsed.collaborators?.resourceId,
        collaborators_alias: parsed.collaborators?.alias,
        collaborators_alias_kind: parsed.collaborators?.aliasKind,
        collaborators_alias_owner: parsed.collaborators?.aliasOwner,
        collaborators_route_error:
          parsed.collaborators?.routeError ??
          (parsed.collaborators?.alias
            ? "Resolving personal alias..."
            : undefined),
        // Library overlays the workspace; keep its selected conversation.
        ...(!parsed.library && !parsed.collaborators
          ? {
              active_agent_id: parsed.agent_id,
              active_agent_name:
                parsed.agent_id && !is_valid_uuid_string(parsed.agent_id)
                  ? parsed.agent_id
                  : undefined,
            }
          : {}),
      });
      redux.getActions("page").set_active_tab("agents", change_history);
      break;

    case "project": {
      const privateApp = parsePrivateProjectAppHandoffTarget(parsed.target);
      if (privateApp != null) {
        void handoffToPrivateProjectApp({
          projectId: privateApp.projectId,
          appId: privateApp.appId,
        }).catch((err) => {
          alert_message({
            type: "error",
            message: `Unable to open private project app: ${err}`,
          });
          redux
            .getActions("projects")
            .load_target(
              `${privateApp.projectId}/servers`,
              true,
              ignore_kiosk,
              change_history,
              Fragment.get(),
            );
        });
        return;
      }
      redux
        .getActions("projects")
        .load_target(
          parsed.target,
          true,
          ignore_kiosk,
          change_history,
          Fragment.get(),
        );
      break;
    }

    case "projects":
      redux.getActions("page").set_active_tab("projects", change_history);
      break;

    case "account":
      redux.getActions("page").set_active_tab("account", false);
      applyAccountSettingsRoute(
        redux.getActions("account"),
        getAccountSettingsRouteFromState({
          active_page: parsed.tab,
        }),
        { pushHistory: change_history },
      );
      redux.getActions("account").setFragment(Fragment.decode(hash));
      break;

    case "notifications": {
      const { filter, id } = getNotificationFilterFromFragment(hash);
      redux.getActions("page").set_active_tab("notifications", change_history);
      const mentions = redux.getActions("mentions");
      if (mentions != null) {
        mentions.set_filter(filter, id);
      } else {
        void import("@cocalc/frontend/notifications/ensure-init")
          .then(({ ensureNotificationsInitialized }) =>
            ensureNotificationsInitialized(),
          )
          .then(() => redux.getActions("mentions")?.set_filter(filter, id))
          .catch(() => {
            // The route-scoped lazy boundary reports and offers recovery for
            // the same failure; URL processing must not create an unhandled one.
          });
      }
      break;
    }

    case "docs":
      redux.getActions("page").setState({ docs_slug: parsed.slug });
      redux.getActions("page").set_active_tab("docs", change_history);
      break;

    case "hosts":
      redux.getActions("page").set_active_tab("hosts", change_history);
      break;

    case "share":
      redux.getActions("page").setState({ share_slug: parsed.slug });
      redux.getActions("page").set_active_tab("share", change_history);
      break;

    case "ssh":
      redux.getActions("page").set_active_tab("ssh", change_history);
      break;

    case "auth":
      redux.getActions("page").setState({
        active_top_tab: "auth",
        auth_view: parsed.view,
      });
      break;

    case "claim":
      redux.getActions("page").set_active_tab("claim", change_history);
      break;

    case "file-use":
      redux.getActions("page").set_active_tab("file-use", change_history);
      break;

    case "admin":
      redux.getActions("page").set_active_tab("admin", false);
      redux.getActions("page").setState({ admin_route: parsed.route });
      if (change_history) {
        set_url(getPageUrlPath(parsed));
      }
      break;
  }
}

window.onpopstate = (_) => {
  if (isPublicApp()) {
    return;
  }
  // The owning chat listens to popstate. Reopening the same file for a drawer
  // selection can create an extra history entry and discard the Forward stack.
  if (consumeGitReviewOnlyNavigation(new URL(location.href))) return;
  load_target(
    document.location.pathname.slice(
      appBasePath.length + (appBasePath.endsWith("/") ? 0 : 1),
    ) + document.location.search,
    false,
    false,
  );
};

export function parse_target(target?: string): ParsedPageTarget {
  return parsePageTarget(target);
}
