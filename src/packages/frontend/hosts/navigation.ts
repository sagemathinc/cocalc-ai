/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { redux } from "@cocalc/frontend/app-framework";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { set_url_with_search } from "@cocalc/frontend/history";
import { getPageUrlPath } from "@cocalc/frontend/page-routing";
import { joinUrlPath } from "@cocalc/util/url-path";

export type HostsPageTab = "hosts" | "vms";

export const HOSTS_PAGE_TAB_EVENT = "cocalc:hosts-page-tab";

const HOSTS_PATH = getPageUrlPath({ page: "hosts" });

function hostsSearch(tab: HostsPageTab): string {
  return tab === "vms" ? "?tab=vms" : "";
}

export function getHostsPageHref(tab: HostsPageTab): string {
  return `${joinUrlPath(appBasePath, HOSTS_PATH)}${hostsSearch(tab)}`;
}

export function openHostsPage(tab: HostsPageTab): void {
  set_url_with_search(HOSTS_PATH, hostsSearch(tab));
  const pageActions = redux.getActions("page") as
    | {
        set_active_tab?: (
          key: string,
          changeHistory?: boolean,
        ) => Promise<void>;
      }
    | undefined;
  void pageActions?.set_active_tab?.("hosts", false);
  globalThis.window?.dispatchEvent(
    new CustomEvent<HostsPageTab>(HOSTS_PAGE_TAB_EVENT, { detail: tab }),
  );
}
