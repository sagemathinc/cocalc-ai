/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { redux, Store, TypedMap } from "@cocalc/frontend/app-framework";
import type { AdminRoute } from "@cocalc/frontend/admin/routing";
import target from "@cocalc/frontend/client/handle-target";
import type { AuthView } from "@cocalc/frontend/auth/types";
import type { ConatConnectionStatus } from "@cocalc/frontend/conat/client";
import type { Options as SupportOpenOptions } from "@cocalc/frontend/support/url";
import {
  type PageTopTab,
  getPageTopTab,
  parsePageTarget,
} from "@cocalc/frontend/page-routing";

type TopTab =
  | PageTopTab
  | "about" // the "/help" page
  | "help"; // i.e., the support dialog that makes a ZenDesk ticket....

export type ConnectionStatus = "disconnected" | "connecting" | "connected";

export interface PageState {
  active_top_tab: TopTab; // key of the active tab
  admin_route?: AdminRoute;
  auth_view?: AuthView;
  show_connection: boolean;
  ping?: number;
  avgping?: number;
  connection_status: ConnectionStatus;
  connection_quality: "good" | "bad" | "flaky";
  new_version?: TypedMap<{ version: number; min_version: number }>;
  fullscreen?: "default" | "kiosk" | "project";
  test?: string; // test query in the URL
  cookie_warning: boolean;
  local_storage_warning: boolean;
  show_file_use: boolean;
  num_ghost_tabs: number;
  session?: string; // session query in the URL
  last_status_time?: Date;
  get_api_key?: string; // Set, e.g., when you visit https://cocalc.com/app?get_api_key=myapp -- see https://doc.cocalc.com/api2/index.html#authentication
  kiosk_project_id?: string;

  // If true, a modal asking whether you want to use a project invite token appears.
  // This is 100% for avoiding tricking a user into clicking on a link and silently
  // adding them to a project.  If they are explicitly on purpose trying to use a project
  // invite token, then they will say yes. Otherwise, they will say no.
  popconfirm?: {
    title?;
    description?;
    open?: boolean;
    ok?: boolean;
    cancelText?: string;
    okText?: string;
  };

  settingsModal?: string;
  supportModalOptions?: SupportOpenOptions;
  supportModalHidden?: boolean;
  conat?: TypedMap<ConatConnectionStatus>;
}

export class PageStore extends Store<PageState> {}

export function init_store() {
  const parsed = parsePageTarget(target);
  const DEFAULT_STATE: PageState = {
    active_top_tab: getPageTopTab(parsed) as TopTab,
    admin_route: parsed.page === "admin" ? parsed.route : undefined,
    auth_view: parsed.page === "auth" ? parsed.view : undefined,
    show_connection: false,
    connection_status: "connecting",
    connection_quality: "good",
    cookie_warning: false,
    local_storage_warning: false,
    show_file_use: false,
    num_ghost_tabs: 0,
  } as const;

  redux.createStore("page", PageStore, DEFAULT_STATE);
}
