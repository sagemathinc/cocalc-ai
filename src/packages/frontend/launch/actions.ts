/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Launch actions are URL-driven intents that survive redirects such as SSO.

Legacy image-launch URLs have been removed. Unknown launch types
are ignored after being persisted once and stripped from the URL.
*/

import { Actions, Store, redux } from "@cocalc/frontend/app-framework";
import * as LS from "@cocalc/frontend/misc/local-storage-typed";
import { QueryParams } from "@cocalc/frontend/misc/query-params";

export const NAME = "launch-actions";
const LS_KEY = NAME;

export type LaunchTypes = string | undefined;

export function is_csi_launchvalue(_launch: string) {
  return false;
}

export function launch_action_description(): string | undefined {
  return undefined;
}

interface LaunchData {
  launch?: string;
  type?: LaunchTypes;
  filepath?: string;
  urlpath?: string;
}

class LaunchActionsStore extends Store<LaunchData> {}

class LaunchActions<LaunchData> extends Actions<LaunchData> {}

redux.createStore<LaunchData, LaunchActionsStore>(NAME, LaunchActionsStore, {});
const actions = redux.createActions(NAME, LaunchActions);

// persist any launch action information in local storage (e.g. it's lost via SSO)
export function store() {
  const launch = QueryParams.get("launch");
  if (launch == null) return;
  try {
    if (typeof launch !== "string") {
      console.warn("WARNING: launch query param must be a string");
      return;
    }
    const type = launch.split("/")[0];
    const data: LaunchData = {
      launch,
      type,
    };
    {
      const filepath = QueryParams.get("filepath");
      if (typeof filepath == "string") {
        data.filepath = filepath;
      }
    }
    {
      const urlpath = QueryParams.get("urlpath");
      if (typeof urlpath == "string") {
        data.urlpath = urlpath;
      }
    }
    LS.set(LS_KEY, data);
    actions.setState(data);
  } finally {
    // Remove the launch parameters from the URL, since they are now known (in localStorage) and
    // we don't want to repeat them any time the user refreshes their browser, etc.
    QueryParams.remove(["launch", "filepath", "urlpath"]);
  }
}

export async function launch() {
  const data: LaunchData | undefined = LS.del<LaunchData>(LS_KEY);
  // console.log("launch-actions data=", data);
  if (data == null) return;
  const { type, launch } = data;
  if (launch == null || type == null || typeof launch != "string") {
    // nothing we can do with this.
    return;
  }
  actions.setState(data);
  try {
    console.warn(`launch type "${type}" unknown`);
    return;
  } catch (err) {
    console.warn(
      `WARNING: launch action "${launch}" of type "${type}" failed -- ${err}`,
    );
  }
}
