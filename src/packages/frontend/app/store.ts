/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { redux, Store, TypedMap } from "@cocalc/frontend/app-framework";
import type { AdminRoute } from "@cocalc/frontend/admin/routing";
import type { CollaboratorsRoute } from "@cocalc/frontend/collaborators/workspace-types";
import target from "@cocalc/frontend/client/handle-target";
import type { AuthView } from "@cocalc/frontend/auth/types";
import type { ConatConnectionStatus } from "@cocalc/frontend/conat/client";
import type { Options as SupportOpenOptions } from "@cocalc/frontend/support/url";
import { is_valid_uuid_string } from "@cocalc/util/misc";
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
  active_agent_id?: string;
  active_agent_name?: string;
  personal_url?: string;
  personal_url_status?: "loading" | "resolved" | "error";
  personal_url_error?: string;
  personal_url_viewer?: string;
  personal_url_owner_account_id?: string;
  personal_url_project_id?: string;
  library_open?: boolean;
  library_project_id?: string;
  library_entry_id?: string;
  collaborators_open?: boolean;
  collaborators_view?: CollaboratorsRoute["view"];
  collaborators_project_id?: string;
  collaborators_project_ids?: string[];
  collaborators_person_id?: string;
  collaborators_contact_id?: string;
  collaborators_invitation_id?: string;
  collaborators_resource_kind?: CollaboratorsRoute["resourceKind"];
  collaborators_resource_id?: string;
  collaborators_route_error?: string;
  collaborators_alias?: string;
  collaborators_alias_kind?: CollaboratorsRoute["aliasKind"];
  collaborators_alias_owner?: string;
  last_project_tab?: string; // project context retained while viewing global pages
  admin_route?: AdminRoute;
  auth_view?: AuthView;
  docs_print?: boolean;
  docs_slug?: string;
  share_slug?: string;
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
  num_ghost_tabs: number;
  session?: string; // session query in the URL
  last_status_time?: Date;
  get_api_key?: string; // Set, e.g., when you visit https://cocalc.ai/app?get_api_key=myapp -- see /docs/api/http-api
  kiosk_project_id?: string;

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
  activity_bar_collapsed?: boolean;
  activity_bar_labels?: boolean;
  activity_bar_order?: string[];
  activity_bar_hidden?: string[];
  agent_chat_font_size?: number;
}

export class PageStore extends Store<PageState> {}

export function init_store() {
  const parsed = parsePageTarget(
    target.includes("?") ? target : `${target}${location.search}`,
  );
  const initialProjectId =
    parsed.page === "project" ? parsed.target.split("/")[0] : undefined;
  const collaborators =
    parsed.page === "agents" ? parsed.collaborators : undefined;
  const DEFAULT_STATE: PageState = {
    active_top_tab: getPageTopTab(parsed) as TopTab,
    personal_url: parsed.page === "agents" ? parsed.personal_url : undefined,
    personal_url_status:
      parsed.page === "agents" && parsed.personal_url ? "loading" : undefined,
    collaborators_open: collaborators != null,
    collaborators_view: collaborators?.view,
    collaborators_project_id: collaborators?.projectId,
    collaborators_project_ids: collaborators?.projectIds,
    collaborators_person_id: collaborators?.personId,
    collaborators_contact_id: collaborators?.contactId,
    collaborators_invitation_id: collaborators?.invitationId,
    collaborators_resource_kind: collaborators?.resourceKind,
    collaborators_resource_id: collaborators?.resourceId,
    collaborators_route_error: collaborators?.routeError,
    collaborators_alias: collaborators?.alias,
    collaborators_alias_kind: collaborators?.aliasKind,
    library_open: parsed.page === "agents" && parsed.library === true,
    library_project_id:
      parsed.page === "agents" ? parsed.artifact_project_id : undefined,
    library_entry_id:
      parsed.page === "agents" ? parsed.artifact_entry_id : undefined,
    active_agent_id: parsed.page === "agents" ? parsed.agent_id : undefined,
    active_agent_name:
      parsed.page === "agents" &&
      parsed.agent_id &&
      !is_valid_uuid_string(parsed.agent_id)
        ? parsed.agent_id
        : undefined,
    last_project_tab: is_valid_uuid_string(initialProjectId)
      ? initialProjectId
      : undefined,
    admin_route: parsed.page === "admin" ? parsed.route : undefined,
    auth_view: parsed.page === "auth" ? parsed.view : undefined,
    docs_print: parsed.page === "docs" ? parsed.print : undefined,
    docs_slug: parsed.page === "docs" ? parsed.slug : undefined,
    share_slug: parsed.page === "share" ? parsed.slug : undefined,
    show_connection: false,
    connection_status: "connecting",
    connection_quality: "good",
    cookie_warning: false,
    local_storage_warning: false,
    num_ghost_tabs: 0,
  } as const;

  redux.createStore("page", PageStore, DEFAULT_STATE);
}
