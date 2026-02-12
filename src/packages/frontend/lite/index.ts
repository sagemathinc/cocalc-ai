import { type CustomizeState } from "@cocalc/frontend/customize";
import {
  FALLBACK_PROJECT_UUID,
  FALLBACK_ACCOUNT_UUID,
} from "@cocalc/util/misc";
import { init as initSyncDoc } from "./sync";

export let lite = false;
export let project_id: string = "";
export let account_id: string = "";

export function init(redux, configuration: CustomizeState) {
  console.log("Initializing CoCalc Lite!");
  lite = true;
  ({
    account_id = FALLBACK_ACCOUNT_UUID,
    project_id = FALLBACK_PROJECT_UUID,
  } = configuration);
  redux.getActions("account").setState({ is_logged_in: true, account_id });
  redux.getActions("projects").setState({
    open_projects: [project_id],
  });
  void redux
    .getActions("projects")
    .open_project({
      project_id,
      target: "home/",
      switch_to: true,
      restore_session: false,
    })
    .catch((err) => {
      console.warn("lite/init: failed to open default home target", err);
    });

  if (configuration.remote_sync) {
    initSyncDoc();
  }
}
