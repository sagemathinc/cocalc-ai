import { type CustomizeState } from "@cocalc/frontend/customize";
import { ACCOUNT_ID_COOKIE } from "@cocalc/frontend/client/client";
import target from "@cocalc/frontend/client/handle-target";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  FALLBACK_PROJECT_UUID,
  FALLBACK_ACCOUNT_UUID,
} from "@cocalc/util/misc";
import { init as initSyncDoc } from "./sync";
import Cookies from "js-cookie";

export let lite = false;
export let project_id: string = "";
export let account_id: string = "";

function getLiteInitialProjectState(
  targetPath: string,
  defaultProjectId: string,
): { switch_to: boolean; target: string } {
  const segments = targetPath.split("/").filter(Boolean);
  if (segments[0] === "projects") {
    if (segments[1] === defaultProjectId) {
      const projectTarget = segments.slice(2).join("/");
      return {
        switch_to: true,
        target: projectTarget || "project-home",
      };
    }
    return {
      switch_to: true,
      target: "project-home",
    };
  }
  return {
    switch_to: false,
    target: "project-home",
  };
}

export function init(redux, configuration: CustomizeState) {
  // console.log("Initializing CoCalc Lite!");
  lite = true;
  ({ account_id = FALLBACK_ACCOUNT_UUID, project_id = FALLBACK_PROJECT_UUID } =
    configuration);
  const initialProjectState = getLiteInitialProjectState(target, project_id);
  const previousAccountId = webapp_client.account_id;
  Cookies.remove(ACCOUNT_ID_COOKIE);
  webapp_client.account_id = account_id;
  redux.getActions("account").setState({ is_logged_in: true, account_id });
  if (previousAccountId !== account_id) {
    webapp_client.emit("signed_in", { account_id, hub: "lite" });
  }
  if (previousAccountId !== account_id) {
    const { recreate_account_table } = require("../account/table-bootstrap");
    recreate_account_table(redux);
  }
  redux.getActions("projects").setState({
    open_projects: [project_id],
  });
  void redux
    .getActions("projects")
    .open_project({
      project_id,
      target: initialProjectState.target,
      switch_to: initialProjectState.switch_to,
      restore_session: false,
    })
    .catch((err) => {
      console.warn(
        "lite/init: failed to open default project-home target",
        err,
      );
    });

  if (configuration.remote_sync) {
    initSyncDoc();
  }
}
