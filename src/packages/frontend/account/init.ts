/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { deep_copy } from "@cocalc/util/misc";
import { SCHEMA } from "@cocalc/util/schema";
import target from "@cocalc/frontend/client/handle-target";
import {
  getInitialAccountPageState,
  parsePageTarget,
} from "@cocalc/frontend/page-routing";
import { webapp_client } from "../webapp-client";
import { AccountActions } from "./actions";
import { AccountStore } from "./store";
import { init_dark_mode } from "./dark-mode";
import { reset_password_key } from "../client/password-reset";
import { hasRememberMe } from "@cocalc/frontend/misc/remember-me";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { once } from "@cocalc/util/async-utils";
import { initAccountTable } from "./table-bootstrap";
import Cookies from "js-cookie";
import { ACCOUNT_ID_COOKIE } from "@cocalc/frontend/client/client";
import { parseManagedEgressBlockedError } from "@cocalc/frontend/purchases/managed-egress-blocked";
import { getAuthBootstrap } from "@cocalc/frontend/auth/api";

export function init(redux) {
  // Register account store
  // Use the database defaults for all account info until this gets set after they login
  const init = deep_copy(SCHEMA.accounts.user_query?.get?.fields) ?? {};
  const initialAccountPageState = getInitialAccountPageState(
    parsePageTarget(target),
  );
  if (initialAccountPageState != null) {
    init.active_page = initialAccountPageState.active_page;
    init.active_sub_tab = initialAccountPageState.active_sub_tab;
  }
  // ... except for show_global_info2 (null or a timestamp)
  // REGISTER and STRATEGIES are injected in app.html via the /customize endpoint -- do not delete them!
  init.token = global["REGISTER"];
  init.strategies = global["STRATEGIES"];
  init.other_settings.show_global_info2 = "loading"; // indicates there is no data yet
  init.editor_settings.physical_keyboard = "NO_DATA"; // indicator that there is no data
  init.user_type = hasRememberMe(appBasePath) ? "signing_in" : "public"; // default
  const store = redux.createStore("account", AccountStore, init);
  const actions = redux.createActions("account", AccountActions);

  actions._init(store);
  init_dark_mode(store);

  initAccountTable(redux);

  // Password reset
  actions.setState({ reset_key: reset_password_key() });

  // Login status
  webapp_client.on("signed_in", async (mesg) => {
    const actions = redux.getActions("account");
    actions.setState({ managed_egress_blocked_error: undefined });
    if (mesg?.api_key) {
      // wait for sign in to finish and cookie to get set, then redirect
      setTimeout(() => {
        window.location.href = `https://authenticated?api_key=${mesg.api_key}`;
      }, 2000);
    }
    const table = redux.getTable("account")._table;
    if (table.get_state?.() !== "connected") {
      // not fully signed in until the account table is connected, so that we know
      // email address, etc. If we don't set this, the UI briefly shows the
      // pre-sign-in state.
      await once(table, "connected");
    }
    try {
      const bootstrap = await getAuthBootstrap();
      actions.setState({
        home_bay_id: bootstrap.home_bay_id,
        home_bay_source: bootstrap.home_bay_id
          ? "cluster-directory"
          : undefined,
        impersonation: bootstrap.impersonation ?? null,
      });
    } catch {}
    actions.set_user_type("signed_in");
  });

  webapp_client.on("signed_out", () => {
    const actions = redux.getActions("account");
    actions.setState({
      home_bay_id: undefined,
      home_bay_source: undefined,
      impersonation: null,
      managed_egress_blocked_error: undefined,
    });
    actions.set_user_type("public");
  });

  webapp_client.on("remember_me_failed", ({ error } = {}) => {
    const actions = redux.getActions("account");
    const blocked = parseManagedEgressBlockedError(error);
    if (blocked != null) {
      actions.setState({
        account_id:
          webapp_client.account_id ?? Cookies.get(ACCOUNT_ID_COOKIE) ?? "",
        home_bay_id: undefined,
        home_bay_source: undefined,
        impersonation: null,
        managed_egress_blocked_error: blocked.raw,
        remember_me: false,
        sign_in_error: blocked.raw,
        user_type: "signed_in",
        is_logged_in: true,
      });
      return;
    }
    actions.setState({
      home_bay_id: undefined,
      home_bay_source: undefined,
      impersonation: null,
      managed_egress_blocked_error: undefined,
    });
    actions.set_user_type("public");
  });

  // Autosave interval
  let _autosave_interval: NodeJS.Timeout | undefined = undefined;
  const init_autosave = function (autosave) {
    if (_autosave_interval) {
      // This function can safely be called again to *adjust* the
      // autosave interval, in case user changes the settings.
      clearInterval(_autosave_interval);
      _autosave_interval = undefined;
    }

    // Use the most recent autosave value.
    if (autosave) {
      const save_all_files = function () {
        if (webapp_client.is_connected()) {
          redux.getActions("projects")?.save_all_files();
        }
      };
      _autosave_interval = setInterval(save_all_files, autosave * 1000);
    }
  };

  let _last_autosave_interval_s = undefined;
  store.on("change", function () {
    const interval_s = store.get("autosave");
    if (interval_s !== _last_autosave_interval_s) {
      _last_autosave_interval_s = interval_s;
      init_autosave(interval_s);
    }
  });
}
