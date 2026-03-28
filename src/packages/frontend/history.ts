/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/* Code related to the history and URL in the browser bar.
See also src/packages/util/routing/app.ts
and src/packages/hub/servers/app/app-redirect.ts

The URI schema handled by the single page app is as follows:
     Overall settings:
        https://cocalc.com/settings
     Admin only page:
        https://cocalc.com/admin
      Account settings (default):
         https://cocalc.com/settings/account
      Account sub-tabs:
         https://cocalc.com/settings/account/profile
         https://cocalc.com/settings/account/ai
         https://cocalc.com/settings/account/security
         etc.
     Billing:
        https://cocalc.com/settings/billing
     Licenses:
        https://cocalc.com/settings/licenses
     Support:
        https://cocalc.com/settings/support
     Projects page:
        https://cocalc.com/projects/
     Specific project:
        https://cocalc.com/projects/project-id/
     Create new file page (in given directory):
        https://cocalc.com/projects/project-id/new/path/to/dir
     Search (in given directory):
        https://cocalc.com/projects/project-id/search/path/to/dir
     Settings:
        https://cocalc.com/projects/project-id/settings
     Log:
        https://cocalc.com/projects/project-id/log
     Folder listing (must have slash at end):
       https://cocalc.com/projects/project-id/files/path/to/dir/
     Open file:
       https://cocalc.com/projects/project-id/files/path/to/file
     (From before) raw http:
       https://cocalc.com/projects/project-id/raw/path/...
     (From before) proxy server (supports websockets and ssl) to a given port.
       https://cocalc.com/projects/project-id/port/<number>/.
*/

import { join } from "path";

import { redux } from "@cocalc/frontend/app-framework";
import {
  applyAccountSettingsRoute,
  getAccountSettingsRouteFromState,
} from "@cocalc/frontend/account/settings-routing";
import { IS_EMBEDDED } from "@cocalc/frontend/client/handle-target";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import {
  parsePageTarget,
  type ParsedPageTarget,
} from "@cocalc/frontend/page-routing";
import Fragment from "@cocalc/frontend/misc/fragment-id";
import { getNotificationFilterFromFragment } from "./notifications/fragment";

// Determine query params part of URL based on state of the project store.
// This also leaves unchanged any *other* params already there (i.e., not
// the "managed" params that are explicitly listed in the code below).
function params(): string {
  const page = redux.getStore("page");
  const u = new URL(location.href);
  if (page != null) {
    for (const param of ["get_api_key", "test"]) {
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
let last_full_url: string | undefined = undefined;

// Update what params are set to in the URL based on state of project store,
// leaving the rest of the URL the same.
export function update_params() {
  if (last_url != null) {
    set_url(last_url);
  }
}

// the url must already be URI encoded, e.g., "a/b ? c.md" should be encoded as 'a/b%20?%20c.md'
export function set_url(url: string, hash?: string) {
  if (IS_EMBEDDED) {
    // no need to mess with url in embedded mode.
    return;
  }
  last_url = url;
  const query_params = params();
  const full_url = join(
    appBasePath,
    url + query_params + (hash ?? location.hash),
  );
  if (full_url === last_full_url) {
    // nothing to do
    return;
  }
  last_full_url = full_url;
  history.pushState({}, "", full_url);
}

// Now load any specific page/project/previous state
export function load_target(
  target: string,
  ignore_kiosk: boolean = false,
  change_history: boolean = true,
) {
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
  if (
    !redux.getStore("account").get("is_logged_in") &&
    parsed.page !== "auth"
  ) {
    // this will redirect to the sign in page after a brief pause
    redux.getActions("page").set_active_tab("account", false);
    return;
  }
  switch (parsed.page) {
    case "project":
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

    case "projects":
      redux.getActions("page").set_active_tab("projects", change_history);
      break;

    case "account":
      redux.getActions("page").set_active_tab("account", false);
      applyAccountSettingsRoute(
        redux.getActions("account"),
        getAccountSettingsRouteFromState({
          active_page: parsed.tab,
          active_sub_tab: parsed.sub_tab,
        }),
        { pushHistory: change_history },
      );
      redux.getActions("account").setFragment(Fragment.decode(hash));
      break;

    case "notifications": {
      const { filter, id } = getNotificationFilterFromFragment(hash);
      redux.getActions("mentions").set_filter(filter, id);
      redux.getActions("page").set_active_tab("notifications", change_history);
      break;
    }

    case "hosts":
      redux.getActions("page").set_active_tab("hosts", change_history);
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

    case "file-use":
      redux.getActions("page").set_active_tab("file-use", change_history);
      break;

    case "admin":
      redux.getActions("page").set_active_tab("admin", change_history);
      break;
  }
}

window.onpopstate = (_) => {
  load_target(
    decodeURIComponent(
      document.location.pathname.slice(
        appBasePath.length + (appBasePath.endsWith("/") ? 0 : 1),
      ),
    ),
    false,
    false,
  );
};

export function parse_target(target?: string): ParsedPageTarget {
  return parsePageTarget(target);
}
